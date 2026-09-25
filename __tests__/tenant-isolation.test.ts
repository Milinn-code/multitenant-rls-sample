// テナント単位の分離（テスト1〜5）。
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import {
    deleteReservation,
    listReservations,
    rescheduleReservation,
    searchByCustomerLabelWithoutTenantFilter,
} from "../src/repositories/reservations.js";
import {
    RESERVATION_A1,
    RESERVATION_B1,
    SHARED_LABEL,
    STORE_B1,
    TENANT_A,
    TENANT_B,
    adminA,
    adminFetchReservation,
    newAdminPool,
    newAppPool,
    resetFixtures,
} from "./helpers.js";

const admin = newAdminPool();
const app = newAppPool();

beforeEach(() => resetFixtures(admin));
afterAll(async () => {
    await app.end();
    await admin.end();
});

describe("1. テナント A の設定では、B の行が SELECT で1行も返らない", () => {
    it.each(["app.tenants", "app.stores", "app.staff", "app.reservations"])("%s", async (table) => {
        const column = table === "app.tenants" ? "id" : "tenant_id";
        const rows = await withTenant(
            adminA,
            async ({ client }) =>
                (await client.query(`SELECT ${column} AS tenant FROM ${table}`)).rows,
            app,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenant === TENANT_A)).toBe(true);
    });
});

describe("2. A の設定で B の行を UPDATE・DELETE しても0件", () => {
    it("UPDATE は0件で、B の行は変わらない", async () => {
        const before = await adminFetchReservation(admin, RESERVATION_B1);
        const count = await withTenant(
            adminA,
            ({ client }) =>
                client.query("UPDATE app.reservations SET starts_at = now() WHERE id = $1", [RESERVATION_B1]),
            app,
        );
        expect(count.rowCount).toBe(0);
        expect(await adminFetchReservation(admin, RESERVATION_B1)).toEqual(before);
    });

    it("DELETE は0件で、B の行は残る", async () => {
        const count = await withTenant(
            adminA,
            ({ client }) => client.query("DELETE FROM app.reservations WHERE id = $1", [RESERVATION_B1]),
            app,
        );
        expect(count.rowCount).toBe(0);
        expect(await adminFetchReservation(admin, RESERVATION_B1)).toBeDefined();
    });

    it("リポジトリ関数経由でも0件", async () => {
        const [updated, deleted] = await withTenant(
            adminA,
            async (tx) => [
                await rescheduleReservation(tx, RESERVATION_B1, new Date()),
                await deleteReservation(tx, RESERVATION_B1),
            ],
            app,
        );
        expect(updated).toBe(0);
        expect(deleted).toBe(0);
    });
});

describe("3. 他テナントの tenant_id での書き込みは拒否される（WITH CHECK）", () => {
    it("tenant_id = B の INSERT は拒否される", async () => {
        await expect(
            withTenant(
                adminA,
                ({ client }) =>
                    client.query(
                        `INSERT INTO app.reservations (tenant_id, store_id, customer_label, starts_at)
                         VALUES ($1, $2, 'intrusion', now())`,
                        [TENANT_B, STORE_B1],
                    ),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("自テナントの行の tenant_id を B に書き換える UPDATE は拒否される", async () => {
        await expect(
            withTenant(
                adminA,
                ({ client }) =>
                    client.query("UPDATE app.reservations SET tenant_id = $1 WHERE id = $2", [
                        TENANT_B,
                        RESERVATION_A1,
                    ]),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
        expect((await adminFetchReservation(admin, RESERVATION_A1))?.tenant_id).toBe(TENANT_A);
    });
});

describe("4. テナントを設定しないと、どのテーブルも0行（fail-closed）", () => {
    it.each(["app.tenants", "app.stores", "app.staff", "app.reservations"])("%s", async (table) => {
        // withTenant を通さず、素の接続で問い合わせる
        const { rows } = await app.query(`SELECT * FROM ${table}`);
        expect(rows).toHaveLength(0);
    });

    it("空文字を設定しても0行", async () => {
        const client = await app.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', '', true)");
            const { rows } = await client.query("SELECT * FROM app.reservations");
            expect(rows).toHaveLength(0);
        } finally {
            await client.query("ROLLBACK");
            client.release();
        }
    });
});

describe("5. アプリ側で条件を付け忘れた関数でも、他テナントの行は返らない", () => {
    it("tenant_id の条件がない検索でも、A の予約だけが返る", async () => {
        const rows = await withTenant(
            adminA,
            (tx) => searchByCustomerLabelWithoutTenantFilter(tx, SHARED_LABEL),
            app,
        );
        // DB 上は A・B の両方に同じラベルの予約があるが、返るのは A のものだけ
        const { rows: all } = await admin.query("SELECT 1 FROM app.reservations WHERE customer_label = $1", [
            SHARED_LABEL,
        ]);
        expect(all).toHaveLength(3);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    });

    it("比較: 通常の関数（条件あり）と同じ結果になる", async () => {
        const [unsafe, safe] = await withTenant(
            adminA,
            async (tx) => [await searchByCustomerLabelWithoutTenantFilter(tx, SHARED_LABEL), await listReservations(tx)],
            app,
        );
        expect(unsafe.map((r) => r.id).sort()).toEqual(safe.map((r) => r.id).sort());
    });
});
