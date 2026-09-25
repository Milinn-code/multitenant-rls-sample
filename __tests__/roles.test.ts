// 8. app_user は RLS を無効にできず、ポリシーも変えられず、テーブルの所有者でもない。
//    不要な権限（id の指定、一時テーブルの作成）も持たない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import { TENANT_A, adminA, newAdminPool, newAppPool, resetFixtures } from "./helpers.js";

const admin = newAdminPool();
const app = newAppPool();

const TENANT_TABLES = ["tenants", "stores", "staff", "reservations"];

// このファイルのテストはデータを変更しないので、初期化は最初の1回だけ
beforeAll(() => resetFixtures(admin));
afterAll(async () => {
    await app.end();
    await admin.end();
});

describe("8. app_user の権限", () => {
    it("スーパーユーザーではなく、BYPASSRLS も持たない", async () => {
        const { rows } = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'");
        expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });

    it("tenant_id 列を持つテーブルはすべて ENABLE + FORCE で、テナント単位のポリシーがある（新しいテーブルの付け忘れも検出）", async () => {
        // テーブルを固定のリストで書かず、カタログから列挙する
        const { rows } = await admin.query<{ relname: string; enabled: boolean; forced: boolean; policies: string[] }>(
            `SELECT c.relname,
                    c.relrowsecurity AS enabled,
                    c.relforcerowsecurity AS forced,
                    ARRAY(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
               FROM pg_class c
              WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r'
                AND (c.relname = 'tenants'
                     OR EXISTS (SELECT 1 FROM pg_attribute a
                                 WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
              ORDER BY c.relname`,
        );
        expect(rows.map((r) => r.relname)).toEqual(expect.arrayContaining(TENANT_TABLES));
        for (const row of rows) {
            expect(row, row.relname).toMatchObject({ enabled: true, forced: true });
            expect(row.policies, row.relname).toContain("tenant_isolation");
        }
    });

    it("app スキーマのどのテーブルの所有者でもない", async () => {
        const { rows } = await admin.query<{ owner: string }>(
            `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
              WHERE relnamespace = 'app'::regnamespace AND relkind = 'r'`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.owner !== "app_user")).toBe(true);
    });

    it("id を指定して INSERT できない（一意制約のエラーから他テナントの行の存在を推測させない）", async () => {
        await expect(
            withTenant(
                adminA,
                ({ client }) =>
                    client.query("INSERT INTO app.stores (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'x')", [
                        TENANT_A,
                    ]),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });
    });

    it("一時テーブルを作れない", async () => {
        await expect(app.query("CREATE TEMP TABLE t_probe (x int)")).rejects.toMatchObject({ code: "42501" });
    });

    it.each(TENANT_TABLES)("app.%s の RLS を DISABLE できない", async (table) => {
        await expect(app.query(`ALTER TABLE app.${table} DISABLE ROW LEVEL SECURITY`)).rejects.toMatchObject({
            code: "42501",
            message: expect.stringMatching(/must be owner/),
        });
    });

    it("ポリシーを削除・追加できない", async () => {
        await expect(app.query("DROP POLICY tenant_isolation ON app.reservations")).rejects.toMatchObject({
            code: "42501",
        });
        await expect(
            app.query("CREATE POLICY open_all ON app.reservations USING (true)"),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("row_security = off にしても RLS はすり抜けられず、エラーになる", async () => {
        await expect(
            withTenant(
                adminA,
                async ({ client }) => {
                    await client.query("SET LOCAL row_security = off");
                    return client.query("SELECT * FROM app.reservations");
                },
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("テナント横断の関数も、監査ログも使えない", async () => {
        await expect(app.query("SELECT * FROM app.ops_reservation_summary('x')")).rejects.toMatchObject({
            code: "42501",
        });
        await expect(
            app.query("INSERT INTO app.audit_log (actor, action, reason) VALUES ('x', 'x', 'x')"),
        ).rejects.toMatchObject({ code: "42501" });
    });
});
