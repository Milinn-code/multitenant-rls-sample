-- ロールとスキーマ。スーパーユーザーで実行する。
--
--   migrator             : テーブル・ポリシーの所有者。ログイン不可（アプリからは使わない）
--   app_user             : アプリが接続するロール。所有者ではなく BYPASSRLS も持たない
--   ops_user             : 運営者用。テナント横断の専用関数を EXECUTE できるだけ
--   cross_tenant_definer : 横断用 SECURITY DEFINER 関数の所有者。ログイン不可。
--                          RLS をすり抜けられる唯一のロールだが、権限は関数が使う最小限だけ
--
-- パスワードはローカル開発用の固定値（docker-compose.yml / .env.example と対応）。

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
        CREATE ROLE migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'app_user_local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_user') THEN
        CREATE ROLE ops_user LOGIN PASSWORD 'ops_user_local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cross_tenant_definer') THEN
        CREATE ROLE cross_tenant_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    END IF;
END
$$;

-- public スキーマの既定権限を閉じ、アプリのオブジェクトは専用スキーマに置く
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- 一時テーブルの作成権限（既定で PUBLIC に付く）も取り消す。アプリの接続に不要な権限は与えない
DO $$
BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

CREATE SCHEMA app AUTHORIZATION migrator;
GRANT USAGE ON SCHEMA app TO app_user, ops_user, cross_tenant_definer;

-- 関数の EXECUTE は既定で PUBLIC に付く。migrator が作る関数ではそれを取り消し、
-- 実行できるロールを関数ごとに明示的に GRANT する
ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
