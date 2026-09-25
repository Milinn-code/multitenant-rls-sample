# Architecture Decision Records

設計判断の記録。形式は Michael Nygard の軽量 ADR（[template.md](template.md)）。

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-rls-defense-in-depth.md) | テナント分離をアプリ側の条件と RLS の二重で守る | accepted | 2026-09-25 |
| [0002](0002-separate-db-roles.md) | DB ロールを用途ごとに分け、アプリは RLS を外せないロールで接続する | accepted | 2026-09-25 |
| [0003](0003-cross-tenant-operations.md) | テナントをまたぐ操作は、操作ごとの SECURITY DEFINER 関数と監査ログに限定する | accepted | 2026-09-25 |
| [0004](0004-store-level-scope.md) | 店舗単位の分離は、ロールを明示する GUC と RESTRICTIVE ポリシーで行う | accepted | 2026-09-25 |
