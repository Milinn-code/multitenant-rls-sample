import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["__tests__/**/*.test.ts"],
        // 全テストファイルが同じ DB を初期化・利用するので、ファイル単位でも直列に実行する
        fileParallelism: false,
        testTimeout: 15_000,
    },
});
