// 6. トランザクションが終わると設定が消え、同じコネクションの次の利用者に漏れない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import { STORE_A1, TENANT_A, adminA, newAdminPool, newAppPool, resetFixtures } from "./helpers.js";

const admin = newAdminPool();
// max: 1 にして、必ず同じ物理コネクションが使い回されるようにする
const app = newAppPool(1);

beforeAll(() => resetFixtures(admin));
afterAll(async () => {
    await app.end();
    await admin.end();
});

async function backendPid(): Promise<number> {
    const { rows } = await app.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return rows[0]!.pid;
}

describe("6. 設定はトランザクションの外に漏れない", () => {
    it("withTenant の後、同じコネクションでは設定が空で、予約は0行", async () => {
        const pidBefore = await backendPid();

        // store_id まで設定される store_manager で試し、3つの設定すべてが消えることを確かめる
        const inside = await withTenant(
            { tenantId: TENANT_A, role: "store_manager", storeId: STORE_A1 },
            async ({ client }) => ({
                pid: (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid,
                tenant: (await client.query<{ t: string }>("SELECT current_setting('app.tenant_id') AS t")).rows[0]!.t,
                count: (await client.query("SELECT 1 FROM app.reservations")).rowCount,
            }),
            app,
        );
        expect(inside.pid).toBe(pidBefore);
        expect(inside.tenant).toBe(TENANT_A);
        expect(inside.count).toBeGreaterThan(0);

        // 同じコネクション（pid が同じ）を次の利用者として借りる
        const after = await app.query<{ pid: number; tenant: string | null; role: string | null; store: string | null }>(
            `SELECT pg_backend_pid() AS pid,
                    current_setting('app.tenant_id', true) AS tenant,
                    current_setting('app.role', true) AS role,
                    current_setting('app.store_id', true) AS store`,
        );
        expect(after.rows[0]!.pid).toBe(pidBefore);
        // 一度設定された後は NULL ではなく空文字に戻る。どちらでも「未設定」として扱われる
        expect(after.rows[0]!.tenant ?? "").toBe("");
        expect(after.rows[0]!.role ?? "").toBe("");
        expect(after.rows[0]!.store ?? "").toBe("");
        expect((await app.query("SELECT 1 FROM app.reservations")).rowCount).toBe(0);
    });

    it("コールバックが例外を投げても（ROLLBACK でも）設定は残らない", async () => {
        await expect(
            withTenant(
                adminA,
                async () => {
                    throw new Error("boom");
                },
                app,
            ),
        ).rejects.toThrow("boom");

        const { rows } = await app.query<{ tenant: string | null }>(
            "SELECT current_setting('app.tenant_id', true) AS tenant",
        );
        expect(rows[0]!.tenant ?? "").toBe("");
        expect((await app.query("SELECT 1 FROM app.reservations")).rowCount).toBe(0);
    });
});
