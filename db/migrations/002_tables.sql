-- テーブル。所有者は migrator。
--
-- テナントに属するテーブルは tenant_id UUID NOT NULL を持つ。
-- 子テーブルは (tenant_id, 親id) の複合外部キーで親を参照する。
-- 外部キーの検査は RLS を通らないため、単純な store_id 参照だと
-- 「他テナントの店舗を指す行」を作れてしまう。複合キーでそれをスキーマで禁止する。

SET LOCAL ROLE migrator;

CREATE TABLE app.tenants (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.stores (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES app.tenants (id),
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE app.staff (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL,
    store_id     uuid        NOT NULL,
    display_name text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    -- 予約から「同じ店舗のスタッフ」だけを参照させるための一意キー
    UNIQUE (tenant_id, store_id, id),
    FOREIGN KEY (tenant_id, store_id) REFERENCES app.stores (tenant_id, id)
);

CREATE TABLE app.reservations (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL,
    store_id       uuid        NOT NULL,
    staff_id       uuid,
    customer_label text        NOT NULL,
    starts_at      timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, store_id) REFERENCES app.stores (tenant_id, id),
    -- 担当スタッフは同じテナント・同じ店舗の人だけ。staff_id が NULL（担当未定）なら検査しない（MATCH SIMPLE）
    FOREIGN KEY (tenant_id, store_id, staff_id) REFERENCES app.staff (tenant_id, store_id, id)
);
CREATE INDEX reservations_tenant_store_starts_idx ON app.reservations (tenant_id, store_id, starts_at);
-- スタッフの更新・削除時の外部キー検査用（担当未定の行は対象外）
CREATE INDEX reservations_tenant_store_staff_idx ON app.reservations (tenant_id, store_id, staff_id)
    WHERE staff_id IS NOT NULL;

-- アプリ用ロール: テナントの一覧・作成はできない（プロビジョニングは管理側の仕事）
GRANT SELECT ON app.tenants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.stores, app.staff, app.reservations TO app_user;

-- 横断用関数の所有者: 集計に必要な読み取りだけ
GRANT SELECT ON app.tenants, app.stores, app.reservations TO cross_tenant_definer;
