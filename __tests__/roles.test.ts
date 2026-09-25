// 8. app_user は RLS を無効にできず、テーブルの所有者でもない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import { adminA, newAdminPool, newAppPool, resetFixtures } from "./helpers.js";

const admin = newAdminPool();
const app = newAppPool();

const TENANT_TABLES = ["tenants", "stores", "staff", "reservations"];

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

    it("どのテーブルの所有者でもなく、テナントのテーブルはすべて ENABLE + FORCE", async () => {
        const { rows } = await admin.query<{ relname: string; owner: string; enabled: boolean; forced: boolean }>(
            `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
                    c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
               FROM pg_class c
              WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r'`,
        );
        expect(rows.every((r) => r.owner !== "app_user")).toBe(true);
        for (const table of TENANT_TABLES) {
            expect(rows.find((r) => r.relname === table)).toMatchObject({ enabled: true, forced: true });
        }
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
