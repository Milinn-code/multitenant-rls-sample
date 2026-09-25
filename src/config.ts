// 接続先。既定値はすべて docker-compose.yml のローカル用固定値（秘密情報ではない）。
export const adminDatabaseUrl =
    process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/rls_sample";

export const appDatabaseUrl =
    process.env.APP_DATABASE_URL ?? "postgres://app_user:app_user_local@localhost:54329/rls_sample";

export const opsDatabaseUrl =
    process.env.OPS_DATABASE_URL ?? "postgres://ops_user:ops_user_local@localhost:54329/rls_sample";
