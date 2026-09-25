// アプリ側の防御線: すべての DB アクセスは withTenant() の中で行う。
//
// テナント・ロール・店舗は set_config(..., true)（= SET LOCAL）でトランザクション内だけに設定する。
// COMMIT / ROLLBACK で自動的に消えるので、プールから同じコネクションを次に借りた利用者には漏れない。
import pg from "pg";
import { appDatabaseUrl } from "./config.js";

/**
 * 誰として DB にアクセスするか。
 * 判別共用体なので「store_manager なのに storeId がない」状態はコンパイル時点で作れない。
 */
export type TenantContext =
    | { tenantId: string; role: "tenant_admin" }
    | { tenantId: string; role: "store_manager"; storeId: string };

/** withTenant のコールバックに渡す、テナントが設定済みのトランザクション。 */
export interface TenantTx {
    readonly client: pg.PoolClient;
    readonly ctx: TenantContext;
}

let defaultPool: pg.Pool | undefined;

/** app_user で接続するプール（所有者ではなく BYPASSRLS もないロール）。 */
export function getAppPool(): pg.Pool {
    defaultPool ??= new pg.Pool({ connectionString: appDatabaseUrl });
    return defaultPool;
}

export async function closeAppPool(): Promise<void> {
    await defaultPool?.end();
    defaultPool = undefined;
}

export async function withTenant<T>(
    ctx: TenantContext,
    fn: (tx: TenantTx) => Promise<T>,
    pool: pg.Pool = getAppPool(),
): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
        await client.query("BEGIN");
        // 3つを1文で設定し、途中まで設定された中間状態を作らない
        await client.query(
            `SELECT set_config('app.tenant_id', $1, true),
                    set_config('app.role',      $2, true),
                    set_config('app.store_id',  $3, true)`,
            [ctx.tenantId, ctx.role, ctx.role === "store_manager" ? ctx.storeId : ""],
        );
        const result = await fn({ client, ctx });
        await client.query("COMMIT");
        return result;
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            // ROLLBACK もできない接続は状態が不明なので、プールに戻さず破棄する
            broken = true;
        }
        throw err;
    } finally {
        client.release(broken);
    }
}
