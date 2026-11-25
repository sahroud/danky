import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { incrementFeatureUsage } from "../src/index.js";

describe("Cloudflare D1 usage enforcement", () => {
  beforeAll(async () => {
    // This test uses only the local Miniflare D1 binding; it never touches remote D1 or Family Guard.
    await env.CORE_DB.exec("DROP TABLE IF EXISTS feature_usage");
    await env.CORE_DB.prepare(`
      CREATE TABLE feature_usage (
        account_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        feature_key TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, product_key, feature_key)
      )
    `).run();
    await env.CORE_DB.prepare(`
      INSERT INTO feature_usage
        (account_id, product_key, feature_key, used_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind("test-account", "steel", "dxf-export", 2, "2026-11-25T00:00:00Z", "2026-11-25T00:00:00Z").run();
  });

  afterAll(async () => {
    await env.CORE_DB.exec("DROP TABLE IF EXISTS feature_usage");
  });

  it("enforces the remaining three uses through the real Worker usage function under concurrency", async () => {
    const now = new Date().toISOString();
    const access = {
      account: { account_id: "test-account" },
      limit: 5,
      usedCount: 2
    };

    // Exercise the production function, not a copy of its SQL, against local Miniflare D1.
    const outcomes = await Promise.all(Array.from({ length: 40 }, () =>
      incrementFeatureUsage(env, access, "steel", "dxf-export", now)
    ));

    const accepted = outcomes.filter(result => result.consumed).map(result => result.usedCount);
    const rejected = outcomes.filter(result => !result.consumed).length;
    const finalRow = await env.CORE_DB.prepare(
      "SELECT used_count FROM feature_usage WHERE account_id=? AND product_key=? AND feature_key=?"
    ).bind("test-account", "steel", "dxf-export").first();

    expect(accepted).toHaveLength(3);
    expect(rejected).toBe(37);
    expect(accepted.sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(finalRow.used_count).toBe(5);
  });
});
