// テスト共通: 接続と、固定 ID のテストデータ。
//
// データの投入・検証用には管理用接続（スーパーユーザー）を使う。
// 検証対象の操作は、必ず app_user（withTenant 経由）か ops_user で行う。
import pg from "pg";
import { adminDatabaseUrl, appDatabaseUrl, opsDatabaseUrl } from "../src/config.js";
import type { TenantContext } from "../src/db.js";

export const TENANT_A = "00000000-0000-4000-8000-0000000000a0";
export const TENANT_B = "00000000-0000-4000-8000-0000000000b0";

export const STORE_A1 = "00000000-0000-4000-8000-0000000000a1";
export const STORE_A2 = "00000000-0000-4000-8000-0000000000a2";
export const STORE_B1 = "00000000-0000-4000-8000-0000000000b1";

export const STAFF_A1 = "00000000-0000-4000-8000-00000000a1f1";
export const STAFF_B1 = "00000000-0000-4000-8000-00000000b1f1";

export const RESERVATION_A1 = "00000000-0000-4000-8000-00000000a1e1";
export const RESERVATION_A2 = "00000000-0000-4000-8000-00000000a2e1";
export const RESERVATION_B1 = "00000000-0000-4000-8000-00000000b1e1";

/** 全テナントの予約に共通して付けておくラベル（条件の付け忘れを実演するため）。 */
export const SHARED_LABEL = "walk-in";

export const adminA: TenantContext = { tenantId: TENANT_A, role: "tenant_admin" };
export const adminB: TenantContext = { tenantId: TENANT_B, role: "tenant_admin" };

export function newAdminPool(): pg.Pool {
    return new pg.Pool({ connectionString: adminDatabaseUrl });
}

export function newAppPool(max = 10): pg.Pool {
    return new pg.Pool({ connectionString: appDatabaseUrl, max });
}

export function newOpsPool(): pg.Pool {
    return new pg.Pool({ connectionString: opsDatabaseUrl });
}

/** 業務テーブルを空にして、固定のテストデータを入れ直す（監査ログは append-only なので触らない）。 */
export async function resetFixtures(admin: pg.Pool): Promise<void> {
    const client = await admin.connect();
    try {
        await client.query("BEGIN");
        await client.query("TRUNCATE app.reservations, app.staff, app.stores, app.tenants");
        for (const [id, name] of [
            [TENANT_A, "Tenant A"],
            [TENANT_B, "Tenant B"],
        ]) {
            await client.query("INSERT INTO app.tenants (id, name) VALUES ($1, $2)", [id, name]);
        }
        for (const [id, tenantId, name] of [
            [STORE_A1, TENANT_A, "A-1"],
            [STORE_A2, TENANT_A, "A-2"],
            [STORE_B1, TENANT_B, "B-1"],
        ]) {
            await client.query("INSERT INTO app.stores (id, tenant_id, name) VALUES ($1, $2, $3)", [id, tenantId, name]);
        }
        for (const [id, tenantId, storeId, name] of [
            [STAFF_A1, TENANT_A, STORE_A1, "staff-a1"],
            [STAFF_B1, TENANT_B, STORE_B1, "staff-b1"],
        ]) {
            await client.query(
                "INSERT INTO app.staff (id, tenant_id, store_id, display_name) VALUES ($1, $2, $3, $4)",
                [id, tenantId, storeId, name],
            );
        }
        for (const [id, tenantId, storeId, staffId, startsAt] of [
            [RESERVATION_A1, TENANT_A, STORE_A1, STAFF_A1, "2026-10-01T10:00:00Z"],
            [RESERVATION_A2, TENANT_A, STORE_A2, null, "2026-10-01T11:00:00Z"],
            [RESERVATION_B1, TENANT_B, STORE_B1, STAFF_B1, "2026-10-01T12:00:00Z"],
        ]) {
            await client.query(
                `INSERT INTO app.reservations (id, tenant_id, store_id, staff_id, customer_label, starts_at)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, tenantId, storeId, staffId, SHARED_LABEL, startsAt],
            );
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * withTenant を通さずに GUC を直接設定して fn を実行し、最後に必ず ROLLBACK する。
 * 型では作れない不正な設定（role 未設定など）や、生の SQL を試すために使う。
 * ROLLBACK が失敗した接続は、状態が不明なのでプールに戻さず破棄する（withTenant と同じ扱い）。
 */
export async function withRawSettings<T>(
    pool: pg.Pool,
    settings: Record<string, string>,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
        await client.query("BEGIN");
        for (const [key, value] of Object.entries(settings)) {
            await client.query("SELECT set_config($1, $2, true)", [key, value]);
        }
        return await fn(client);
    } finally {
        try {
            await client.query("ROLLBACK");
        } catch {
            broken = true;
        }
        client.release(broken);
    }
}

/** 管理用接続で、RLS を通さずに行の実在を確認する。 */
export async function adminFetchReservation(
    admin: pg.Pool,
    id: string,
): Promise<{ tenant_id: string; starts_at: Date } | undefined> {
    const { rows } = await admin.query<{ tenant_id: string; starts_at: Date }>(
        "SELECT tenant_id, starts_at FROM app.reservations WHERE id = $1",
        [id],
    );
    return rows[0];
}
