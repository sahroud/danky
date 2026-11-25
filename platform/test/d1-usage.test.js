import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

const usageUpsert = `
INSERT INTO feature_usage
  (account_id, product_key, feature_key, used_count, created_at, updated_at)
SELECT ?, ?, ?, 1, ?, ?
WHERE (? IS NULL OR ? > 0)
ON CONFLICT(account_id, product_key, feature_key)
DO UPDATE SET
  used_count = feature_usage.used_count + 1,
  updated_at = excluded.updated_at
WHERE (? IS NULL OR feature_usage.used_count < ?)
RETURNING used_count
`;

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

  it("accepts only the remaining three of forty concurrent consumes", async () => {
    const now = new Date().toISOString();
    const attempts = Array.from({ length: 40 }, () =>
      env.CORE_DB.prepare(usageUpsert)
        .bind("test-account", "steel", "dxf-export", now, now, 5, 5, 5, 5)
        .first()
    );

    const outcomes = await Promise.all(attempts);
    const accepted = outcomes.filter(Boolean).map(row => row.used_count);
    const rejected = outcomes.filter(row => row === null).length;
    const finalRow = await env.CORE_DB.prepare(
      "SELECT used_count FROM feature_usage WHERE account_id=? AND product_key=? AND feature_key=?"
    ).bind("test-account", "steel", "dxf-export").first();

    expect(accepted).toHaveLength(3);
    expect(rejected).toBe(37);
    expect(accepted.sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(finalRow.used_count).toBe(5);
  });
});
