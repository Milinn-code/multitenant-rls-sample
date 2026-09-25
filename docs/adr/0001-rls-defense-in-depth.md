# ADR-0001: テナント分離をアプリ側の条件と RLS の二重で守る

**Date**: 2026-09-25
**Status**: accepted
**Deciders**: リポジトリ作成者

## Context

複数の企業（テナント）が1つのデータベースを共有する SaaS では、他テナントのデータが1行でも見えれば重大な情報漏えいになる。
アプリ側で `WHERE tenant_id = ?` を付けるだけの分離は、クエリが増えるほど「1か所の書き忘れ」のリスクが高まり、レビューやテストでも見落としやすい。
スキーマ分割や DB 分割はテナント数が増えると運用コスト（マイグレーション、接続数）が大きい。

## Decision

共有テーブル＋ `tenant_id` 列の構成で、**アプリ側の条件付けと PostgreSQL の Row Level Security（RLS）の二重**でテナントを分離する。

- アプリ側: すべての DB アクセスを `withTenant(ctx, fn)` の中で行い、リポジトリ関数でも `tenant_id` の条件を付ける
- DB 側: テナントに属するテーブルは `ENABLE` と `FORCE ROW LEVEL SECURITY` の両方を付け、`USING` と `WITH CHECK` を持つポリシーで絞る
- テナントは `set_config('app.tenant_id', $1, true)` でトランザクション内だけに設定する（`SET LOCAL` 相当）
- ポリシーは `NULLIF(current_setting('app.tenant_id', true), '')::uuid` と比較し、未設定なら全行拒否（fail-closed）
- 子テーブルは `(tenant_id, 親id)` の複合外部キーで親を参照する（外部キーの検査は RLS を通らないため）

## Alternatives Considered

### Alternative 1: アプリ側の条件付けだけ
- **Pros**: 仕組みが単純。DB の機能に依存しない
- **Cons**: 1か所の書き忘れがそのまま漏えいになる。生 SQL や集計クエリで特に漏れやすい
- **Why not**: 最後の防御線がなく、漏えいを「起こさない」ことを保証できない

### Alternative 2: テナントごとにスキーマ／データベースを分ける
- **Pros**: 物理的な分離が強い。テナント単位のバックアップや削除がしやすい
- **Cons**: テナント数に比例してマイグレーションと接続の管理が重くなる。横断集計が難しい
- **Why not**: 中小規模のテナントが多数ある想定では運用コストが見合わない

### Alternative 3: セッション単位の `SET app.tenant_id`
- **Pros**: 1回設定すればそのコネクションで使い続けられる
- **Cons**: コネクションプールで次の利用者に設定が残る
- **Why not**: 他テナントの設定のまま次のリクエストが実行される事故を、構造的に防げない

## Consequences

### Positive
- アプリ側で条件を書き忘れても、他テナントの行は返らない（`__tests__/tenant-isolation.test.ts` の 5 で実証）
- 設定し忘れた場合は 0 行になり、「何も見えない」という気づきやすい失敗になる
- 分離の仕様が SQL のポリシーとして1か所にまとまり、レビューしやすい

### Negative
- すべてのクエリがトランザクションの中で動く前提になる
- ポリシーの条件が全クエリに付くため、`tenant_id` を先頭にしたインデックスが必要になる

### Risks
- **テーブル所有者や `BYPASSRLS` ロールでアプリが接続すると RLS が効かない** → [ADR-0002](0002-separate-db-roles.md) でロールを分ける
- **新しいテーブルでポリシーを付け忘れる** → テストで全テナントテーブルの `relrowsecurity` / `relforcerowsecurity` を検査する
