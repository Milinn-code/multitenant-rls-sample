-- テナント単位の RLS。
--
-- * ENABLE と FORCE の両方: FORCE がないとテーブル所有者（migrator）には RLS が効かない
-- * app.tenant_id が未設定・空文字なら NULLIF で NULL になり、`tenant_id = NULL` は
--   決して真にならない → 全行拒否（fail-closed）
-- * USING は読み取り・更新・削除の対象行、WITH CHECK は書き込む値を制限する。
--   両方あるので「他テナントの tenant_id で INSERT」「tenant_id を書き換える UPDATE」も拒否される
-- * ポリシー内の関数呼び出しは (SELECT ...) で包み、行ごとではなく1回だけ評価させる

SET LOCAL ROLE migrator;

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_user;

ALTER TABLE app.tenants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants      FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.stores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stores       FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.staff        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff        FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reservations FORCE  ROW LEVEL SECURITY;

-- tenants はテナントそのものなので id で比較する
CREATE POLICY tenant_isolation ON app.tenants
    FOR SELECT TO app_user
    USING (id = (SELECT app.current_tenant_id()));

CREATE POLICY tenant_isolation ON app.stores
    FOR ALL TO app_user
    USING      (tenant_id = (SELECT app.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

CREATE POLICY tenant_isolation ON app.staff
    FOR ALL TO app_user
    USING      (tenant_id = (SELECT app.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

CREATE POLICY tenant_isolation ON app.reservations
    FOR ALL TO app_user
    USING      (tenant_id = (SELECT app.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
