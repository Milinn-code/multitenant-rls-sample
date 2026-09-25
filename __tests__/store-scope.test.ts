// 7. 店舗単位の分離（二段目）。db/migrations/004_store_policies.sql のポリシーを検証する。
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type TenantContext, withTenant } from "../src/db.js";
import {
    createReservation,
    deleteReservation,
    listReservations,
    rescheduleReservation,
} from "../src/repositories/reservations.js";
import { createStaff, listStaff } from "../src/repositories/staff.js";
import { createStore, listStores, renameStore } from "../src/repositories/stores.js";
import {
    RESERVATION_A1,
    RESERVATION_A2,
    STAFF_A1,
    STAFF_B1,
    STORE_A1,
    STORE_A2,
    STORE_B1,
    TENANT_A,
    TENANT_B,
    adminA,
    adminFetchReservation,
    newAdminPool,
    newAppPool,
    resetFixtures,
    withRawSettings,
} from "./helpers.js";

const admin = newAdminPool();
const app = newAppPool();

const managerA1: TenantContext = { tenantId: TENANT_A, role: "store_manager", storeId: STORE_A1 };

beforeEach(() => resetFixtures(admin));
afterAll(async () => {
    await app.end();
    await admin.end();
});

/** 型では作れない不正な設定で SQL を実行する。 */
function queryWithRawSettings(settings: Record<string, string>, sql: string): Promise<pg.QueryResult> {
    return withRawSettings(app, settings, (client) => client.query(sql));
}

describe("7. 店舗の管理者は、同じテナントでも他の店舗の予約が見えない", () => {
    it("tenant_admin は同じテナントの全店舗の予約が見える", async () => {
        const rows = await withTenant(adminA, listReservations, app);
        expect(rows.map((r) => r.storeId).sort()).toEqual([STORE_A1, STORE_A2].sort());
    });

    it("store_manager は自分の店舗の予約だけが見える", async () => {
        const rows = await withTenant(managerA1, listReservations, app);
        expect(rows.map((r) => r.id)).toEqual([RESERVATION_A1]);
    });

    it("store_manager は他店舗の予約を UPDATE・DELETE できない（0件）", async () => {
        const [updated, deleted] = await withTenant(
            managerA1,
            async (tx) => [
                await rescheduleReservation(tx, RESERVATION_A2, new Date()),
                await deleteReservation(tx, RESERVATION_A2),
            ],
            app,
        );
        expect(updated).toBe(0);
        expect(deleted).toBe(0);
        expect(await adminFetchReservation(admin, RESERVATION_A2)).toBeDefined();
    });

    it("store_manager は自分の店舗の予約なら更新できる", async () => {
        const updated = await withTenant(
            managerA1,
            (tx) => rescheduleReservation(tx, RESERVATION_A1, new Date("2026-10-02T10:00:00Z")),
            app,
        );
        expect(updated).toBe(1);
    });

    it("store_manager は他店舗への予約を INSERT できない", async () => {
        await expect(
            withTenant(
                managerA1,
                (tx) => createReservation(tx, { storeId: STORE_A2, customerLabel: "x", startsAt: new Date() }),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("store_manager は自分の予約を他店舗へ付け替えられない", async () => {
        await expect(
            withTenant(
                managerA1,
                ({ client }) =>
                    client.query("UPDATE app.reservations SET store_id = $1 WHERE id = $2", [
                        STORE_A2,
                        RESERVATION_A1,
                    ]),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("担当スタッフは同じ店舗の人だけ（別店舗のスタッフを付けると外部キーで拒否）", async () => {
        await expect(
            withTenant(
                adminA,
                (tx) =>
                    createReservation(tx, {
                        storeId: STORE_A2,
                        staffId: STAFF_A1,
                        customerLabel: "x",
                        startsAt: new Date(),
                    }),
                app,
            ),
        ).rejects.toMatchObject({ code: "23503" });
    });

    describe("fail-closed: 不完全・不正な設定では0行", () => {
        it("role が未設定", async () => {
            const { rowCount } = await queryWithRawSettings(
                { "app.tenant_id": TENANT_A },
                "SELECT 1 FROM app.reservations",
            );
            expect(rowCount).toBe(0);
        });

        it("role が想定外の値", async () => {
            const { rowCount } = await queryWithRawSettings(
                { "app.tenant_id": TENANT_A, "app.role": "superadmin" },
                "SELECT 1 FROM app.reservations",
            );
            expect(rowCount).toBe(0);
        });

        it("store_manager なのに store_id が未設定", async () => {
            const { rowCount } = await queryWithRawSettings(
                { "app.tenant_id": TENANT_A, "app.role": "store_manager", "app.store_id": "" },
                "SELECT 1 FROM app.reservations",
            );
            expect(rowCount).toBe(0);
        });
    });

    describe("テナントと店舗が食い違う設定では、どのテーブルも0行", () => {
        // 二段のポリシーは AND で結ばれるので、どちらかが一致しなければ届かない
        it.each([
            ["テナント B の設定で、A の店舗を指定", TENANT_B, STORE_A1],
            ["テナント A の設定で、B の店舗を指定", TENANT_A, STORE_B1],
        ])("%s", async (_label, tenantId, storeId) => {
            const counts = await withTenant(
                { tenantId, role: "store_manager", storeId },
                async ({ client }) =>
                    Promise.all(
                        ["app.stores", "app.staff", "app.reservations"].map(
                            async (table) => (await client.query(`SELECT 1 FROM ${table}`)).rowCount,
                        ),
                    ),
                app,
            );
            expect(counts).toEqual([0, 0, 0]);
        });
    });

    it("店舗単位のポリシーは3テーブルとも RESTRICTIVE（PERMISSIVE だとテナント単位のポリシーと OR になる）", async () => {
        const { rows } = await admin.query<{ tablename: string; permissive: string }>(
            `SELECT tablename, permissive FROM pg_policies
              WHERE schemaname = 'app' AND policyname = 'store_scope' ORDER BY tablename`,
        );
        expect(rows).toEqual([
            { tablename: "reservations", permissive: "RESTRICTIVE" },
            { tablename: "staff", permissive: "RESTRICTIVE" },
            { tablename: "stores", permissive: "RESTRICTIVE" },
        ]);
    });
});

describe("7b. 店舗単位の制限はスタッフと店舗にもかかる", () => {
    it("store_manager は自分の店舗のスタッフだけが見え、更新もできる", async () => {
        const [staff, updated] = await withTenant(
            managerA1,
            async (tx) => [
                await listStaff(tx),
                (await tx.client.query("UPDATE app.staff SET display_name = 'renamed' WHERE id = $1", [STAFF_A1]))
                    .rowCount,
            ],
            app,
        );
        // 空配列だと every が常に true になるので、中身があることも確かめる
        expect((staff as { id: string; storeId: string }[]).map((s) => [s.id, s.storeId])).toEqual([
            [STAFF_A1, STORE_A1],
        ]);
        expect(updated).toBe(1);
    });

    it("store_manager は他店舗のスタッフを削除できない（0件）", async () => {
        const { rows } = await admin.query<{ id: string }>(
            "INSERT INTO app.staff (tenant_id, store_id, display_name) VALUES ($1, $2, 'staff-a2') RETURNING id",
            [TENANT_A, STORE_A2],
        );
        const otherStoreStaffId = rows[0]!.id;
        const deleted = await withTenant(
            managerA1,
            async ({ client }) => (await client.query("DELETE FROM app.staff WHERE id = $1", [otherStoreStaffId])).rowCount,
            app,
        );
        expect(deleted).toBe(0);
        const { rowCount } = await admin.query("SELECT 1 FROM app.staff WHERE id = $1", [otherStoreStaffId]);
        expect(rowCount).toBe(1);
    });

    it("store_manager は他店舗にスタッフを登録できない", async () => {
        await expect(
            withTenant(managerA1, (tx) => createStaff(tx, STORE_A2, "intruder"), app),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("store_manager は自分の店舗のスタッフを他店舗へ異動させられない", async () => {
        await expect(
            withTenant(
                managerA1,
                ({ client }) =>
                    client.query("UPDATE app.staff SET store_id = $1 WHERE id = $2", [STORE_A2, STAFF_A1]),
                app,
            ),
        ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("store_manager には自分の店舗の行だけが見え、他店舗の名前は変えられない", async () => {
        const [stores, renamed] = await withTenant(
            managerA1,
            async (tx) => [await listStores(tx), await renameStore(tx, STORE_A2, "hijacked")],
            app,
        );
        expect((stores as { id: string }[]).map((s) => s.id)).toEqual([STORE_A1]);
        expect(renamed).toBe(0);
    });

    it("store_manager は新しい店舗を作れないが、tenant_admin は作れる", async () => {
        await expect(withTenant(managerA1, (tx) => createStore(tx, "new-store"), app)).rejects.toMatchObject({
            code: "42501",
            message: expect.stringMatching(/row-level security/),
        });
        const created = await withTenant(adminA, (tx) => createStore(tx, "new-store"), app);
        expect(created.tenantId).toBe(TENANT_A);
    });
});
