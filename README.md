# multitenant-rls-sample

PostgreSQL の **Row Level Security（RLS）** で、マルチテナント SaaS のデータ分離を「アプリにバグがあっても漏れない」形で実装したサンプルです。
**テナント A から B のデータが見えないこと**を、実際の PostgreSQL に対するテストで確かめられます。

題材は、複数の企業が使う店舗運営 SaaS です（テナント（企業）→ 店舗 → スタッフ・予約）。
テナント同士の分離に加えて、「店舗の管理者は自分の店舗のデータだけ」という**二段の分離**を行います。

## 3コマンドで試す

必要なもの: Node.js 20 以上、pnpm、Docker（Compose v2）

```bash
pnpm install
pnpm db:up       # PostgreSQL 16 を docker compose で起動（localhost:54329）
pnpm db:migrate  # ロール・テーブル・ポリシー・関数を作成
pnpm test        # 実際の DB に接続して分離を検証
```

`pnpm db:reset` で DB を作り直せます。

> **パスワードについて:** `docker-compose.yml`・`.env.example`・マイグレーションにあるパスワード（`postgres`、`app_user_local` など）は、**ローカル開発・CI 専用の固定値**です。秘密情報ではなく、本番環境では使いません。

## 設計の軸: 二重の防御

```
リクエスト
   │
   ▼
withTenant(ctx, fn)          ← 1枚目: アプリ側
   │  BEGIN
   │  set_config('app.tenant_id', …, true)   … トランザクション内だけ有効
   │  リポジトリ関数も WHERE tenant_id = … を付ける
   ▼
PostgreSQL RLS               ← 2枚目: DB 側（最後の防御線）
      ENABLE + FORCE ROW LEVEL SECURITY
      USING / WITH CHECK で tenant_id を照合、未設定なら 0 行
```

アプリ側の条件付けだけだと、**1か所の書き忘れがそのまま情報漏えい**になります。
RLS は、その書き忘れを DB で止める最後の防御線です。
このリポジトリには、わざと `tenant_id` の条件を付け忘れた関数（`searchByCustomerLabelWithoutTenantFilter`）を置いてあり、それでも他テナントの行が返らないことをテストで示しています。

### 主な設計判断

| 判断 | 内容 | ADR |
|---|---|---|
| RLS による二重の防御 | `ENABLE` + `FORCE`、`USING` + `WITH CHECK`、未設定なら全行拒否（fail-closed）。設定は `set_config(…, true)` でトランザクション内だけ | [0001](docs/adr/0001-rls-defense-in-depth.md) |
| DB ロールの分離 | アプリの `app_user` は所有者ではなく `BYPASSRLS` もない。RLS をすり抜けられるのは、ログインできない専用ロールだけ | [0002](docs/adr/0002-separate-db-roles.md) |
| テナントをまたぐ操作 | 汎用の抜け道は作らず、操作ごとの `SECURITY DEFINER` 関数に限定。`search_path` を固定し、必ず監査ログを書く | [0003](docs/adr/0003-cross-tenant-operations.md) |
| 店舗単位の分離 | `app.role` と `app.store_id` を明示し、店舗・スタッフ・予約を `AS RESTRICTIVE` のポリシーで絞る。不完全な設定は 0 行 | [0004](docs/adr/0004-store-level-scope.md) |

### DB ロール

| ロール | ログイン | できること |
|---|---|---|
| `migrator` | 不可 | テーブル・ポリシーの所有者（マイグレーション専用） |
| `app_user` | 可 | 業務テーブルの読み書き。RLS を外せない |
| `ops_user` | 可 | テナント横断の専用関数を実行することだけ |
| `cross_tenant_definer` | 不可 | 横断用関数の所有者。`BYPASSRLS` を持つ唯一のロール |

## テストで確かめていること

`__tests__/` のテストは、すべて docker compose で起動した実際の PostgreSQL に接続して実行します（モックは使いません）。

| # | 確かめること | ファイル |
|---|---|---|
| 1 | テナント A の設定で、B の行が SELECT で1行も返らない | `tenant-isolation.test.ts` |
| 2 | A の設定で B の行を UPDATE・DELETE しても 0 件 | 〃 |
| 3 | `tenant_id = B` の INSERT、`tenant_id` を B に書き換える UPDATE は拒否される | 〃 |
| 4 | テナントを設定しないと、どのテーブルも 0 行（fail-closed） | 〃 |
| 5 | アプリ側で条件を付け忘れた関数でも、他テナントの行は返らない | 〃 |
| 6 | トランザクションが終わると設定が消え、同じコネクションの次の利用者に漏れない | `connection-reuse.test.ts` |
| 7 | 店舗の管理者は、同じテナントでも他の店舗の予約・スタッフ・店舗が見えず、他店舗への登録や付け替えもできない。role・store_id が不完全なら 0 行 | `store-scope.test.ts` |
| 8 | `app_user` は RLS を無効にできず、ポリシーも変えられず、テーブルの所有者でもない | `roles.test.ts` |
| 9 | 横断用の関数は結果を返し、必ず監査ログが1行増える。監査ログは、スーパーユーザーでも直接は書き換えられない（トリガーを外す操作は「防げないこと」を参照） | `cross-tenant.test.ts` |

## このサンプルで防げること・防げないこと

RLS が守るのは「**アプリのコードにバグがあっても、他テナントの行に届かない**」ことです。
攻撃者が任意の SQL を実行できる状況や、認証・認可そのものの誤りまでは守りません。

### 防げること（テストで確認済み）

| 起きうること | 何が止めるか | テスト |
|---|---|---|
| クエリで `tenant_id` の条件を書き忘れ、他テナントの行を読む・更新する・削除する | RLS の `USING` | 1, 2, 5 |
| 他テナントの `tenant_id` で INSERT する、`tenant_id` を書き換える | RLS の `WITH CHECK` | 3 |
| テナントを設定し忘れたまま実行する | 未設定なら 0 行（fail-closed） | 4 |
| コネクションプールで、前の利用者のテナント設定が残る | `set_config(…, true)` でトランザクション内だけに設定 | 6 |
| 店舗の管理者が、他店舗の予約・スタッフ・店舗を見る・変える・作る | 店舗単位の RESTRICTIVE ポリシー | 7 |
| 他テナント・他店舗の親（店舗・スタッフ）を指す行を作る | `(tenant_id, store_id, …)` の複合外部キー | 7 |
| アプリの接続ロールで RLS を無効にする、ポリシーを消す、`row_security = off` にする | `app_user` は所有者でも `BYPASSRLS` でもない | 8 |
| 横断操作を、監査ログを残さずに実行する | 操作ごとの `SECURITY DEFINER` 関数が必ず監査ログを書く | 9 |
| 監査ログを UPDATE・DELETE・TRUNCATE で書き換える | GRANT しない ＋ 所有者・スーパーユーザーもトリガーで拒否 | 9 |
| `search_path` を細工して、横断用関数に別のオブジェクトを使わせる | 関数の `search_path` を固定し、名前をすべてスキーマ修飾 | 9 |

### 防げないこと（このサンプルの範囲外）

| 起きうること | 理由と対策 |
|---|---|
| **アプリが誤ったテナント・店舗を渡す**（認証・認可のバグ、クライアントの入力をそのまま使う） | RLS は、`withTenant` に渡された `tenantId`・`role`・`storeId` を信じて絞り込むだけです。値は必ず、認証済みのセッションやトークンから作ってください |
| **SQL インジェクション** | `app_user` は自分で `set_config('app.tenant_id', …)` を実行できるので、任意の SQL を注入されるとテナントを切り替えられます（確認済み）。パラメータ化クエリを徹底することが前提です |
| 同じ店舗・テナントの中での、操作ごとの権限（例: 店舗の管理者が自店舗の予約を一括削除する） | RLS は「どの行に届くか」を決める仕組みで、「どの操作を許すか」はアプリ側の認可で決めます |
| 管理用の接続（スーパーユーザー）や `BYPASSRLS` を持つロールの悪用 | RLS は効きません。これらの資格情報は、アプリから切り離して厳重に管理します |
| 横断用関数そのもののバグ | `SECURITY DEFINER` 関数の中身は RLS に守られないので、関数ごとのレビューとテストが必要です |
| DB の管理者による監査ログの改ざん | テーブルの所有者やスーパーユーザーは、トリガー自体を無効化・削除できます。改ざんを検知するには、ログを外部に転送するなどの仕組みが別に必要です |
| 一意制約のエラーから、他テナントの行の存在を推測する | 主キー（`id`）はテナントをまたいで一意です。このサンプルでは `id` を DB の `gen_random_uuid()` で採番し、アプリから受け取らないことで避けています |
| 通常の読み書きの監査 | 監査ログを書くのは、テナント横断の操作だけです |

HTTP 層・認証・暗号化・バックアップなどは、このサンプルに含まれていません。

## ディレクトリ構成

```
db/migrations/        素の SQL（RLS は SQL が主役なので ORM は使わない）
  001_roles.sql                 ロールとスキーマ、既定権限
  002_tables.sql                テーブルと複合外部キー、GRANT
  003_tenant_policies.sql       テナント単位のポリシー
  004_store_policies.sql        店舗単位のポリシー（店舗・スタッフ・予約、RESTRICTIVE）
  005_audit_log.sql             append-only の監査ログ
  006_cross_tenant_functions.sql  テナント横断の SECURITY DEFINER 関数
src/db.ts             接続プールと withTenant()
src/repositories/     店舗・スタッフ・予約の読み書き
__tests__/            Vitest（実 DB に接続）
docs/adr/             設計判断の記録
scripts/migrate.ts    マイグレーションの実行
```

## 技術スタック

TypeScript / Node.js 20 / [node-postgres](https://node-postgres.com/) / PostgreSQL 16 / Vitest / Docker Compose / GitHub Actions

## 関連

- [portal-core-sample](https://github.com/Milinn-code/portal-core-sample) — もう1つの公開サンプル（純粋なロジックの設計とテスト）
