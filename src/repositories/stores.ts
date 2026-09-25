// 店舗の読み書き。アプリ側でも tenant_id の条件を付ける。
import type { TenantTx } from "../db.js";

export interface Store {
    id: string;
    tenantId: string;
    name: string;
}

const COLUMNS = `id, tenant_id AS "tenantId", name`;

export async function listStores(tx: TenantTx): Promise<Store[]> {
    const { rows } = await tx.client.query<Store>(
        `SELECT ${COLUMNS} FROM app.stores WHERE tenant_id = $1 ORDER BY name`,
        [tx.ctx.tenantId],
    );
    return rows;
}

export async function createStore(tx: TenantTx, name: string): Promise<Store> {
    const { rows } = await tx.client.query<Store>(
        `INSERT INTO app.stores (tenant_id, name) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [tx.ctx.tenantId, name],
    );
    return rows[0]!;
}

/** 更新できた件数を返す（RLS で見えない行は 0 件になる）。 */
export async function renameStore(tx: TenantTx, id: string, name: string): Promise<number> {
    const { rowCount } = await tx.client.query(
        "UPDATE app.stores SET name = $3 WHERE tenant_id = $1 AND id = $2",
        [tx.ctx.tenantId, id, name],
    );
    return rowCount ?? 0;
}
