// スタッフの読み書き。アプリ側でも tenant_id の条件を付ける。
import type { TenantTx } from "../db.js";

export interface Staff {
    id: string;
    tenantId: string;
    storeId: string;
    displayName: string;
}

const COLUMNS = `id, tenant_id AS "tenantId", store_id AS "storeId", display_name AS "displayName"`;

export async function listStaff(tx: TenantTx): Promise<Staff[]> {
    const { rows } = await tx.client.query<Staff>(
        `SELECT ${COLUMNS} FROM app.staff WHERE tenant_id = $1 ORDER BY display_name`,
        [tx.ctx.tenantId],
    );
    return rows;
}

export async function createStaff(tx: TenantTx, storeId: string, displayName: string): Promise<Staff> {
    const { rows } = await tx.client.query<Staff>(
        `INSERT INTO app.staff (tenant_id, store_id, display_name) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [tx.ctx.tenantId, storeId, displayName],
    );
    return rows[0]!;
}
