// db/migrations/*.sql をファイル名順に、1ファイル1トランザクションで適用する。
// 管理用の接続（スーパーユーザー）で実行し、各 SQL の中で必要に応じて
// `SET LOCAL ROLE migrator` に切り替える（テーブルの所有者を migrator にするため）。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { adminDatabaseUrl } from "../src/config.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "db", "migrations");

async function main(): Promise<void> {
    const client = new pg.Client({ connectionString: adminDatabaseUrl });
    await client.connect();
    try {
        // 複数プロセスが同時に実行しても、1つずつ順に適用されるようにする（接続終了で自動解放）
        await client.query("SELECT pg_advisory_lock(hashtext('multitenant-rls-sample:migrate'))");
        // 他の処理がテーブルのロックを持っていたとき、DDL が待ち続けないようにする。
        // （待ち続ける DDL の後ろに、そのテーブルへの通常のクエリも並んでしまうため）
        // advisory lock の順番待ちには効かせたくないので、ロックを取ったあとで設定する
        await client.query("SET lock_timeout = '5s'");
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
                filename   text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )`);
        const applied = new Set(
            (await client.query<{ filename: string }>("SELECT filename FROM public.schema_migrations"))
                .rows.map((r) => r.filename),
        );

        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        for (const file of files) {
            if (applied.has(file)) continue;
            const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                // SQL 内の SET LOCAL ROLE はトランザクション終了まで残るので、記録の前に戻す
                await client.query("RESET ROLE");
                await client.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [file]);
                await client.query("COMMIT");
                console.log(`applied ${file}`);
            } catch (err) {
                try {
                    await client.query("ROLLBACK");
                } catch {
                    // ROLLBACK の失敗（接続断など）で、元のエラーを上書きしない
                }
                const reason = err instanceof Error ? err.message : String(err);
                // cause に元のエラーを残し、SQLSTATE（err.code）やスタックを失わない
                throw new Error(`failed to apply ${file}: ${reason}`, { cause: err });
            }
        }
    } finally {
        await client.end();
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
