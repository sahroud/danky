import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" }
    })
  ],
  test: {
    include: ["test/d1-usage.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false
  }
});
