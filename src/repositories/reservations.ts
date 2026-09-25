// 予約の読み書き。
//
// 通常の関数は、アプリ側でも tenant_id の条件を付ける（二重の防御の1枚目）。
// searchByCustomerLabelWithoutTenantFilter() だけは、あえて条件を付け忘れた関数として置いている。
// それでも他テナントの行が返らないのは、DB 側の RLS（2枚目）が止めるから。
import type { TenantTx } from "../db.js";

export interface Reservation {
    id: string;
    tenantId: string;
    storeId: string;
    staffId: string | null;
    customerLabel: string;
    startsAt: Date;
}

const COLUMNS = `id, tenant_id AS "tenantId", store_id AS "storeId", staff_id AS "staffId",
                 customer_label AS "customerLabel", starts_at AS "startsAt"`;

export async function listReservations(tx: TenantTx): Promise<Reservation[]> {
    const { rows } = await tx.client.query<Reservation>(
        `SELECT ${COLUMNS} FROM app.reservations WHERE tenant_id = $1 ORDER BY starts_at`,
        [tx.ctx.tenantId],
    );
    return rows;
}

export interface NewReservation {
    storeId: string;
    staffId?: string | null;
    customerLabel: string;
    startsAt: Date;
}

export async function createReservation(tx: TenantTx, input: NewReservation): Promise<Reservation> {
    const { rows } = await tx.client.query<Reservation>(
        `INSERT INTO app.reservations (tenant_id, store_id, staff_id, customer_label, starts_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [tx.ctx.tenantId, input.storeId, input.staffId ?? null, input.customerLabel, input.startsAt],
    );
    return rows[0]!;
}

/** 更新できた件数を返す（RLS で見えない行は 0 件になる）。 */
export async function rescheduleReservation(tx: TenantTx, id: string, startsAt: Date): Promise<number> {
    const { rowCount } = await tx.client.query(
        "UPDATE app.reservations SET starts_at = $3 WHERE tenant_id = $1 AND id = $2",
        [tx.ctx.tenantId, id, startsAt],
    );
    return rowCount ?? 0;
}

/** 削除できた件数を返す（RLS で見えない行は 0 件になる）。 */
export async function deleteReservation(tx: TenantTx, id: string): Promise<number> {
    const { rowCount } = await tx.client.query(
        "DELETE FROM app.reservations WHERE tenant_id = $1 AND id = $2",
        [tx.ctx.tenantId, id],
    );
    return rowCount ?? 0;
}

/**
 * ⚠️ デモ用: アプリ側の tenant_id 条件を「書き忘れた」関数。
 * 実際のコードベースでは、こうした1か所の書き忘れが情報漏えいの典型的な原因になる。
 * このサンプルでは RLS があるので、他テナントの行は返らない（__tests__ で実証）。
 */
export async function searchByCustomerLabelWithoutTenantFilter(
    tx: TenantTx,
    customerLabel: string,
): Promise<Reservation[]> {
    const { rows } = await tx.client.query<Reservation>(
        `SELECT ${COLUMNS} FROM app.reservations WHERE customer_label = $1 ORDER BY starts_at`,
        [customerLabel],
    );
    return rows;
}
