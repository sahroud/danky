import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { OPERATION_ASSERTION_SECRET: "local-test-secret-not-for-production-000000000000" }
      }
    })
  ],
  test: {
    include: ["test/d1-usage.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false
  }
});
