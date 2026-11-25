# SAHROUD CENTRAL runtime admission policy

## Purpose

Migration 0006 stores configurable limits for product runtime admission. It does not change product operational databases and does not itself enforce sessions or heavy-operation concurrency.

## Policy precedence

1. Account + product override, when a value is non-NULL.
2. Product default.
3. No cap when the resolved product value is NULL, unless a product-specific safety rule explicitly requires one.

Plan-level limits remain in `plans.limits_json`; the future policy resolver must apply the active plan first, then an explicit account override, with a documented rule for whether an account override may raise a plan cap. The safe default is that an account override may lower a cap; raising it requires central-admin authorization and an audit event.

## Separate limits

- **Devices per account:** distinct registered device identities allowed for an account/product. A device identity must be bound to an authenticated account; never trust a client-supplied label as proof of a new device.
- **Concurrent sessions per account:** live session leases. A lease is active only until its expiry and must be refreshed by an authenticated heartbeat. Logout/revocation releases it; expired leases are reclaimed.
- **Concurrent operations per product:** permits for expensive work, independent of the number of signed-in users. A user may have a session but still wait for an operation permit.
- **Queue depth and wait:** bounded queue for work that can safely wait. Reject with a retryable capacity response when both permits and queue slots are exhausted.

## Concurrency correctness

Do not enforce session or operation caps with a D1 `SELECT COUNT(*)` followed by an `INSERT`: simultaneous requests can both observe a free slot and exceed the cap. Use a product-scoped Cloudflare Durable Object as the serialized coordinator for heavy operations. It issues opaque lease/permit IDs, stores expiries, supports heartbeat/release/revoke, and reclaims expired records. The product-wide operation cap and per-account cap are independent; queue depth is likewise bounded separately at product and account scope. Registered-device and session admission are separate lifecycles and are not implemented by the operation coordinator. The Worker authenticates the account and checks central entitlement before asking the coordinator. D1 remains the source for policy configuration and audit metadata, not the distributed lock.

A permit must be released in a `finally` path by the trusted product backend. Long-running jobs need heartbeat/renewal and a maximum lease lifetime. Client disconnects must not permanently consume capacity.

## Security and isolation

- Product backends must enforce the policy before starting protected/heavy work; hiding buttons is not enforcement.
- The coordinator must validate product/account scope on every operation and must not accept arbitrary account IDs without a Worker-authenticated assertion.
- Never put device fingerprints, precise location, or unnecessary personal data in central audit metadata.
- Never share operational data or session payloads with FAMILY GUARD. Its database remains untouched.
- Policy changes and overrides must be admin-authorized and audited.
- No fixed default device/session cap is imposed by this migration. Defaults are configurable per product and plan; choose production values only after load testing.

## Implementation still required

- Authenticated policy read/admin write APIs and Persian admin controls.
- Device registration and authenticated session lifecycle, with atomic per-account caps and lease expiry.
- Product backend adapters for STEEL, UTM, TASBIH, and other products, each enforcing its own workload semantics and releasing permits in finally.
- Capacity metrics and load tests before enabling caps for paying customers.

Migration 0006 is schema-only until those pieces are implemented and deployed with explicit approval. Do not run a remote migration or deploy from this change.
