-- テナント横断の操作は、操作ごとの SECURITY DEFINER 関数だけで行う。
--
-- * 汎用的な「RLS をすり抜ける関数」は作らない。1関数 = 1つの決まった操作
-- * 所有者は BYPASSRLS を持つ cross_tenant_definer（migrator の所有だと FORCE RLS で止まる）
-- * SET search_path を固定し、中の名前はすべてスキーマ修飾する
--   （呼び出し側が一時スキーマ等に同名オブジェクトを置いて乗っ取る攻撃を防ぐ）
-- * 結果を返す前に必ず監査ログを書く。同じトランザクションなので、
--   監査ログが書けなければ結果も返らない
-- * EXECUTE は ops_user だけ。app_user（テナント側のアプリ）からは呼べない

SET LOCAL ROLE migrator;

CREATE FUNCTION app.ops_reservation_summary(p_reason text)
    RETURNS TABLE (tenant_id uuid, tenant_name text, store_count bigint, reservation_count bigint)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'reason is required for cross-tenant operations'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- SECURITY DEFINER の中では current_user は所有者になる。呼び出したログインロールは session_user
    INSERT INTO app.audit_log (actor, action, reason)
    VALUES (session_user, 'ops_reservation_summary', p_reason);

    RETURN QUERY
        SELECT t.id,
               t.name,
               (SELECT count(*) FROM app.stores s WHERE s.tenant_id = t.id),
               (SELECT count(*) FROM app.reservations r WHERE r.tenant_id = t.id)
          FROM app.tenants t
         ORDER BY t.name;
END
$$;

RESET ROLE;

-- 所有者の変更はスーパーユーザーで行う（migrator に BYPASSRLS ロールへの所属を与えないため）
ALTER FUNCTION app.ops_reservation_summary(text) OWNER TO cross_tenant_definer;
REVOKE ALL ON FUNCTION app.ops_reservation_summary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ops_reservation_summary(text) TO ops_user;
