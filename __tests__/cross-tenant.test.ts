// 9. 横断用の SECURITY DEFINER 関数は結果を返し、必ず監査ログが1行増える。
//    監査ログは、所有者やスーパーユーザーでも直接は書き換えられない
//    （トリガー自体を外す操作は防げない。README の「防げないこと」を参照）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    TENANT_A,
    TENANT_B,
    newAdminPool,
    newAppPool,
    newOpsPool,
    resetFixtures,
    withRawSettings,
} from "./helpers.js";

const admin = newAdminPool();
const app = newAppPool();
const ops = newOpsPool();

beforeAll(() => resetFixtures(admin));
afterAll(async () => {
    await Promise.all([app.end(), ops.end()]);
    await admin.end();
});

async function auditCount(): Promise<number> {
    const { rows } = await admin.query<{ n: string }>("SELECT count(*) AS n FROM app.audit_log");
    return Number(rows[0]!.n);
}

describe("9. テナント横断の操作", () => {
    it("全テナントの集計を返し、監査ログが1行増える", async () => {
        const before = await auditCount();

        const { rows } = await ops.query(
            "SELECT tenant_id, store_count, reservation_count FROM app.ops_reservation_summary($1)",
            ["monthly report"],
        );
        expect(rows).toEqual([
            { tenant_id: TENANT_A, store_count: "2", reservation_count: "2" },
            { tenant_id: TENANT_B, store_count: "1", reservation_count: "1" },
        ]);

        expect(await auditCount()).toBe(before + 1);
        const { rows: latest } = await admin.query(
            "SELECT actor, action, reason FROM app.audit_log ORDER BY id DESC LIMIT 1",
        );
        // actor は関数の所有者ではなく、呼び出したログインロール
        expect(latest[0]).toEqual({ actor: "ops_user", action: "ops_reservation_summary", reason: "monthly report" });
    });

    it("理由が空なら実行できず、監査ログも増えない", async () => {
        const before = await auditCount();
        await expect(ops.query("SELECT * FROM app.ops_reservation_summary('  ')")).rejects.toMatchObject({
            code: "22023",
        });
        expect(await auditCount()).toBe(before);
    });

    it("ops_user は関数を通さずにテーブルを直接読めない", async () => {
        await expect(ops.query("SELECT * FROM app.reservations")).rejects.toMatchObject({ code: "42501" });
    });

    it("関数の search_path は固定されている", async () => {
        const { rows } = await admin.query<{ config: string[] }>(
            "SELECT proconfig AS config FROM pg_proc WHERE oid = 'app.ops_reservation_summary(text)'::regprocedure",
        );
        expect(rows[0]!.config).toContain("search_path=pg_catalog, pg_temp");
    });

    describe("監査ログは append-only", () => {
        it("app_user・ops_user は UPDATE・DELETE できない（権限なし）", async () => {
            for (const pool of [app, ops]) {
                await expect(pool.query("UPDATE app.audit_log SET reason = 'x'")).rejects.toMatchObject({
                    code: "42501",
                });
                await expect(pool.query("DELETE FROM app.audit_log")).rejects.toMatchObject({ code: "42501" });
            }
        });

        it.each([
            ["所有者（migrator）", "migrator"],
            ["スーパーユーザー（postgres）", "postgres"],
        ])("%s でも、直接の書き換えはトリガーで拒否される", async (_label, role) => {
            // UPDATE・DELETE の行トリガーは対象の行がないと発火しないので、必ず1行以上ある状態にする
            await ops.query("SELECT * FROM app.ops_reservation_summary('fixture for append-only test')");

            await withRawSettings(admin, {}, async (client) => {
                if (role === "migrator") await client.query("SET LOCAL ROLE migrator");
                for (const sql of [
                    "UPDATE app.audit_log SET reason = 'tampered'",
                    "DELETE FROM app.audit_log",
                    "TRUNCATE app.audit_log",
                ]) {
                    await client.query("SAVEPOINT s");
                    await expect(client.query(sql)).rejects.toMatchObject({
                        message: expect.stringMatching(/append-only/),
                    });
                    await client.query("ROLLBACK TO SAVEPOINT s");
                }
            });
        });
    });
});
