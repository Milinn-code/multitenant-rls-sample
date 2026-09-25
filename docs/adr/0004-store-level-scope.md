# ADR-0004: 店舗単位の分離は、ロールを明示する GUC と RESTRICTIVE ポリシーで行う

**Date**: 2026-09-25
**Status**: accepted
**Deciders**: リポジトリ作成者（Skeptic・Pragmatist・Critic の3つの観点で案を比較して決定）

## Context

同じテナントの中でも、店舗の管理者（`store_manager`）は自分の店舗のデータ（店舗そのもの・スタッフ・予約）だけ、テナントの管理者（`tenant_admin`）は全店舗のデータを扱う、という二段目の分離が必要。
テナント単位の分離（[ADR-0001](0001-rls-defense-in-depth.md)）は「未設定なら 0 行」という fail-closed を原則にしている。二段目でも同じ原則を守りたい。

## Decision

- `withTenant` の ctx を判別共用体にする: `{ tenantId, role: 'tenant_admin' } | { tenantId, role: 'store_manager', storeId }`
- `app.tenant_id`・`app.role`・`app.store_id` の3つを、1つの SELECT でまとめて `set_config(..., true)` する（途中まで設定された状態を作らない）
- 店舗・スタッフ・予約の3テーブルに **`AS RESTRICTIVE`** のポリシー `store_scope` を追加し、`USING` と `WITH CHECK` に同じ式を書く（店舗テーブルでは `store_id` の代わりに `id` と比べる）:

```sql
COALESCE(
    (SELECT app.current_app_role()) = 'tenant_admin'
    OR ((SELECT app.current_app_role()) = 'store_manager'
        AND store_id = (SELECT app.current_store_id())), false)
```

- 式は関数に共通化せず、ポリシーごとに直接書く
- 予約の担当スタッフは `(tenant_id, store_id, staff_id)` の複合外部キーで、同じ店舗のスタッフに限る

## Alternatives Considered

### Alternative A: `app.store_id` だけを追加し、空ならテナント管理者とみなす
- **Pros**: GUC が1つ増えるだけで最も単純
- **Cons**: 「店舗 ID を設定し忘れると全店舗が見える」＝設定がないほど権限が広がる
- **Why not**: テナント単位の fail-closed と正反対の振る舞いが同じリポジトリに並び、原則が一貫しない

### Alternative C: 店舗管理者用に別の DB ロールを作り、ポリシーの `TO` 句で分ける
- **Pros**: DB のロールで権限の違いを表現できる
- **Cons**: ロールごとに接続プールが必要。結局、店舗 ID は GUC で渡す必要がある
- **Why not**: 得られるものに対して構成が複雑すぎる

### 却下した書き方: ロールごとに RESTRICTIVE ポリシーを分ける
- RESTRICTIVE 同士は AND で結ばれるので、`tenant_admin` にも店舗の条件が掛かってしまう。1つの式の中で OR で分岐させる必要がある

### 却下した書き方: PERMISSIVE にする
- PERMISSIVE 同士は OR で結ばれるので、テナント単位のポリシーを満たすだけで他店舗の予約が見えてしまう

### 却下した書き方: 式を SQL 関数（例: `app.can_access_store(store_id)`）に共通化する
- 本体に `(SELECT ...)` を含む SQL 関数はインライン展開されず、行ごとの関数呼び出しになる。含まない関数は展開されるが、`current_setting` が行ごとに評価され initPlan にならない（どちらも EXPLAIN で確認）
- どの列と比べているかが関数の中に隠れ、ポリシーを読んだだけでは分からなくなる
- 重複する3つの式は、`__tests__/store-scope.test.ts` で3テーブルそれぞれを検査して守る

### 却下した書き方: 店舗の作成を GRANT／REVOKE で止める
- アプリのロールは `app_user` の1つなので、GRANT では `tenant_admin` と `store_manager` を区別できない

### 却下した範囲: 予約だけ、または予約とスタッフだけに制限する
- 店舗テーブルに店舗単位のポリシーがないと、`store_manager` が他店舗の名前を書き換えたり、新しい店舗を作れたりする
- スタッフに制限がないと、他店舗のスタッフの一覧を見たり、他店舗にスタッフを登録できたりする

## Consequences

### Positive
- role が未設定・想定外の値、または `store_manager` なのに store_id が未設定なら、いずれも 0 行（`__tests__/store-scope.test.ts`）
- 「store_manager なのに storeId がない」状態は、TypeScript の型の時点で作れない
- `COALESCE(..., false)` により、NULL を拒否として扱う RLS の暗黙の性質に頼らず、fail-closed が式の上で読める（動作は同じ）

- `store_manager` は、他店舗へのスタッフ登録・異動、他店舗の名前の変更、新しい店舗の作成ができない（同）

### Negative
- 式の中で role の種類ごとに分岐するため、role が増えると式が長くなる
- 同じ形の式が3つのポリシーに重複する。変更するときは3か所をそろえる必要がある

### Risks
- **誤って PERMISSIVE で作り直される** → `pg_policies` で3つの `store_scope` が RESTRICTIVE であることをテストで検査する。実際に予約のポリシーを PERMISSIVE へ差し替えると、テスト7の8件が失敗することを確認済み
- **アプリが誤った role・store_id を渡す** → RLS は渡された値を信じるだけなので、値を認証情報から正しく導くことはアプリ側の責任。型とテストで守る
