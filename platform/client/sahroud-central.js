/**
 * SAHROUD Central browser client.
 *
 * Read-only public API helper. It deliberately has no account tokens,
 * license secrets, write methods, or persistent credential storage.
 */

const PRODUCT_KEY_PATTERN = /^[a-z0-9-]{2,64}$/;

export class SahroudCentralError extends Error {
  constructor(code, status = null) {
    super(code || "central_api_error");
    this.name = "SahroudCentralError";
    this.code = code || "central_api_error";
    this.status = status;
  }
}

function normalizeApiBase(apiBase) {
  if (typeof apiBase !== "string" || !apiBase.trim()) {
    throw new TypeError("apiBase_required");
  }

  let url;
  try {
    url = new URL(apiBase.trim());
  } catch {
    throw new TypeError("apiBase_must_be_a_valid_absolute_url");
  }

  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new TypeError("apiBase_must_use_https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("apiBase_must_not_contain_credentials_query_or_fragment");
  }

  return url.href.replace(/\/+$/, "");
}

export class SahroudCentralClient {
  constructor({ apiBase, fetchImpl = globalThis.fetch } = {}) {
    this.apiBase = normalizeApiBase(apiBase);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetch_unavailable");
    }
    this.fetchImpl = fetchImpl;
  }

  async get(path, { signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.apiBase + path, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal
      });
    } catch {
      throw new SahroudCentralError("network_error");
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new SahroudCentralError("invalid_json_response", response.status);
    }

    if (!response.ok) {
      const code = typeof data?.error === "string" ? data.error : "http_error";
      throw new SahroudCentralError(code, response.status);
    }

    return data;
  }

  health(options) {
    return this.get("/health", options);
  }

  version(options) {
    return this.get("/v1/version", options);
  }

  products(options) {
    return this.get("/v1/catalog/products", options);
  }

  product(productKey, options) {
    if (typeof productKey !== "string" || !PRODUCT_KEY_PATTERN.test(productKey)) {
      throw new TypeError("invalid_product_key");
    }
    return this.get("/v1/catalog/products/" + encodeURIComponent(productKey), options);
  }
}

export function createSahroudCentralClient(config) {
  return new SahroudCentralClient(config);
}
