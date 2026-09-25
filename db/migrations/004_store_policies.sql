-- 店舗単位の分離（二段目）。
--
-- テナント単位のポリシー（003）で「同じテナントの行」に絞ったうえで、
-- 店舗の管理者（store_manager）は自分の店舗の予約だけ、
-- テナントの管理者（tenant_admin）は同じテナントの全店舗の予約、に制限する。
--
-- 前提（withTenant が設定する。すべてトランザクション内だけ有効）:
--   app.role     : 'tenant_admin' または 'store_manager'
--   app.store_id : store_manager のときの店舗 ID（tenant_admin のときは空文字）
--
-- 方針は docs/adr を参照（role を明示する方式。未設定・不正値は fail-closed）。

SET LOCAL ROLE migrator;

-- 未設定・空文字なら NULL を返す（tenant_id と同じ考え方）
CREATE FUNCTION app.current_app_role() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.role', true), '') $$;

CREATE FUNCTION app.current_store_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.store_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app.current_app_role(), app.current_store_id() TO app_user;

-- 店舗単位のポリシー。店舗に属するデータ（店舗そのもの・スタッフ・予約）すべてにかける。
--
-- * RESTRICTIVE: 003 の tenant_isolation（PERMISSIVE）と AND で結ばれ、同じテナントの中をさらに絞る。
--   PERMISSIVE にすると OR で結ばれ、同じテナントでありさえすれば他店舗も見えてしまう。
--   また RESTRICTIVE だけでは行を許可できないので、tenant_isolation が無ければ全行拒否のまま。
-- * ロールごとにポリシーを分けないこと。RESTRICTIVE 同士は AND になり、
--   tenant_admin にも店舗の条件が掛かってしまう。1つの式の中で OR で分岐させる。
-- * COALESCE(..., false): role・store_id が未設定・不正値のとき、式は NULL になる。RLS は NULL を
--   拒否として扱うので動作は同じだが、fail-closed であることを式の上で明示する。
-- * USING と WITH CHECK は同じ式。他店舗への INSERT や、他店舗への付け替え UPDATE も拒否する。
-- * 式は共通化せず、テーブルごとに直接書く。SQL 関数にまとめると、(SELECT ...) を含む関数は
--   インライン展開されず行ごとの関数呼び出しになり、含まない関数は展開されても initPlan にならない
--   （どちらも EXPLAIN で確認）。どの列を比べているかもポリシーを見ただけで分かる。
-- * 3つのポリシーが RESTRICTIVE であることは __tests__/store-scope.test.ts で検査する。

-- 店舗: store_manager は自分の店舗の行だけ。新しい店舗の作成は tenant_admin だけ
CREATE POLICY store_scope ON app.stores
    AS RESTRICTIVE
    FOR ALL TO app_user
    USING (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND id = (SELECT app.current_store_id())), false))
    WITH CHECK (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND id = (SELECT app.current_store_id())), false));

-- スタッフ: store_manager は自分の店舗のスタッフだけ（他店舗への異動 UPDATE も拒否）
CREATE POLICY store_scope ON app.staff
    AS RESTRICTIVE
    FOR ALL TO app_user
    USING (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND store_id = (SELECT app.current_store_id())), false))
    WITH CHECK (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND store_id = (SELECT app.current_store_id())), false));

-- 予約: store_manager は自分の店舗の予約だけ
CREATE POLICY store_scope ON app.reservations
    AS RESTRICTIVE
    FOR ALL TO app_user
    USING (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND store_id = (SELECT app.current_store_id())), false))
    WITH CHECK (COALESCE(
        (SELECT app.current_app_role()) = 'tenant_admin'
        OR ((SELECT app.current_app_role()) = 'store_manager'
            AND store_id = (SELECT app.current_store_id())), false));
