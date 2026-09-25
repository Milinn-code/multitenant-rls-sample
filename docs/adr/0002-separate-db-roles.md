# ADR-0002: DB ロールを用途ごとに分け、アプリは RLS を外せないロールで接続する

**Date**: 2026-09-25
**Status**: accepted
**Deciders**: リポジトリ作成者

## Context

RLS は、スーパーユーザーと `BYPASSRLS` 属性を持つロールには効かない。テーブルの所有者にも、`FORCE ROW LEVEL SECURITY` がなければ効かない。
所有者はポリシーの削除や `DISABLE ROW LEVEL SECURITY` もできる。
開発の手軽さからアプリがマイグレーション用のロール（＝所有者）で接続していると、RLS を入れても実際には効いていない、という事故が起きる。

## Decision

ロールを次の4つに分け、アプリは `app_user` でだけ接続する。

| ロール | ログイン | 役割 |
|---|---|---|
| `migrator` | 不可 | テーブル・ポリシーの所有者。マイグレーションで `SET ROLE` して使う |
| `app_user` | 可 | アプリ用。所有者ではなく `BYPASSRLS` もない。業務テーブルへの DML だけ（INSERT・UPDATE は列単位で許可し、`id` 列は書けない） |
| `ops_user` | 可 | 運営者用。テナント横断の専用関数の EXECUTE だけ（[ADR-0003](0003-cross-tenant-operations.md)） |
| `cross_tenant_definer` | 不可 | 横断用 `SECURITY DEFINER` 関数の所有者。`BYPASSRLS` を持つ唯一のロール |

あわせて、アプリの接続に不要な権限は与えない。

- `public` スキーマの既定権限を取り消し、オブジェクトは専用の `app` スキーマに置く
- `migrator` が作る関数は、既定で PUBLIC に付く EXECUTE を `ALTER DEFAULT PRIVILEGES` で取り消す
- 一時テーブルの作成権限（既定で PUBLIC に付く `TEMPORARY`）を取り消す
- `id` 列は DB の `gen_random_uuid()` だけで採番し、`app_user` には書かせない。`id` を指定できると、一意制約違反のエラーから他テナントの行の存在を推測できるため
監査ログ（`app.audit_log`）は、どのロールにも UPDATE・DELETE を許可せず、さらにトリガーで所有者やスーパーユーザーによる UPDATE・DELETE・TRUNCATE も拒否する（append-only）。

## Alternatives Considered

### Alternative 1: アプリも所有者ロールで接続し、`FORCE ROW LEVEL SECURITY` だけで守る
- **Pros**: ロールが1つで済む
- **Cons**: 所有者は `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` やポリシーの削除ができる。SQL インジェクション1つで分離を外せる
- **Why not**: 「アプリにバグがあっても漏れない」という前提が成り立たない

### Alternative 2: `migrator` に `BYPASSRLS` を与え、横断用関数もその所有にする
- **Pros**: ロールが1つ減る
- **Cons**: マイグレーションやシード投入の誤りが、全テナントに無条件で及ぶ
- **Why not**: RLS をすり抜けられるロールは、権限を最小にした専用のものに限定したい

## Consequences

### Positive
- `app_user` は RLS を無効にできず、ポリシーも変更できない（`__tests__/roles.test.ts` で実証）
- `SET row_security = off` を実行しても、すり抜けずにエラーになる
- RLS をすり抜けられるロールがどれか、`pg_roles` を見れば一目で分かる

### Negative
- ロールと GRANT の管理が増える。新しいテーブルを追加するたびに、ロールごとの権限を明示する必要がある
- マイグレーションは管理用接続（スーパーユーザー）から `SET LOCAL ROLE migrator` で実行する必要がある

### Risks
- **新しいテーブルの GRANT 漏れ・過剰な GRANT** → マイグレーションで権限を明示的に書き、テストでロール属性と所有者を検査する
- **ローカル用の固定パスワードが本番に流用される** → README に「ローカル専用」と明記し、本番では環境変数とシークレット管理を使う
