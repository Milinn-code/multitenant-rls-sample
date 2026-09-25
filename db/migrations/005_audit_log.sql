-- 監査ログ（append-only）。
--
-- * どのロールにも UPDATE・DELETE・TRUNCATE を GRANT しない
-- * さらにトリガーで、所有者（migrator）による UPDATE・DELETE・TRUNCATE も拒否する
--   （所有者は GRANT なしでも書き換えられるため、権限だけでは足りない）
-- * INSERT できるのは横断用関数の所有者だけ。アプリからは直接書けない

SET LOCAL ROLE migrator;

CREATE TABLE app.audit_log (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor       text        NOT NULL,
    action      text        NOT NULL,
    reason      text        NOT NULL,
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE FUNCTION app.reject_audit_log_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $$
BEGIN
    RAISE EXCEPTION 'app.audit_log is append-only (% is not allowed)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON app.audit_log
    FOR EACH ROW EXECUTE FUNCTION app.reject_audit_log_change();

CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON app.audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_log_change();

GRANT INSERT ON app.audit_log TO cross_tenant_definer;
