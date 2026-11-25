# Runtime Admission Coordinator Design

Status: Durable Object class, signed assertions, local Cloudflare-runtime tests, alarm-based lease cleanup, Worker-side policy resolver/signer, and authenticated Worker acquire/heartbeat/release routes are implemented on the feature branch. Product-backend adapters and device/session lifecycle remain incomplete. Wrangler namespace binding and SQLite class migration are for local/runtime testing only. No deployment or remote migration has occurred.

## Safety boundary

The central Worker is the only public entry point. It authenticates the Firebase identity, resolves the selected central account, loads the effective policy, and then invokes an internal Durable Object (DO) coordinator. Clients must never receive a DO stub or be allowed to call a coordinator endpoint directly.

This work is limited to the SAHROUD CENTRAL control plane. Do not bind, migrate, query, or modify the SAHROUD FAMILY GUARD operational database. No remote migration or Worker deployment is authorized by this design.

## Admission scopes

Keep these independent:
- Registered devices per account/product.
- Active authenticated sessions per account/product.
- Active heavy operations per product (global product capacity).
- Active heavy operations per account/product (fairness and account-level caps). The deterministic coordinator now enforces a signed per-account cap independently of the product-wide cap; each queued request retains the account cap that was signed when it entered the queue.
- Bounded waiting queue and maximum wait duration, with separate product-wide and per-account queue ceilings.

A device registration is not a session, and a session is not an operation permit. Do not treat a client-supplied device label or fingerprint as proof of device identity.

## Coordinator placement

Use a Durable Object with serialized state transitions. A deterministic DO name is derived by the Worker from the product key. This single product-scoped object enforces the product-wide cap across all accounts while tracking each account's own cap and queue ceiling. Never accept arbitrary DO names from clients.

The Worker should load and validate the product policy and account override from Central D1, resolve plan-level caps, and pass a short-lived, signed internal assertion to the coordinator. The assertion should bind the operation, account, product, policy version, limits, expiry, and request nonce. The DO must validate the signature and scope before changing state. Do not trust client-provided limits or account identifiers.

## Lease and permit lifecycle

Every session or operation permit uses a cryptographically random, unguessable lease ID and has an expiry. Support:
- acquire (idempotent for a supplied request idempotency key)
- heartbeat/renew (bounded by maximum lifetime)
- release (idempotent)
- revoke by account/product or lease
- expiry cleanup during every state-changing request
- bounded queue admission with deterministic FIFO ordering and expiry
- audit metadata for grant, deny, timeout, expiry, release, and revoke

Use finally in product backends to release operation permits. Long-running work must heartbeat. A crashed client must not hold capacity past the lease expiry. Re-check revocation and current policy at renewal; policy reductions should prevent new admissions and define how existing leases are handled.

## Policy precedence

Resolve limits in one documented function:
1. Product policy establishes the baseline.
2. Active plan entitlements may impose stricter caps.
3. Account/product override may reduce caps.
4. A cap can be raised above the plan only by an explicitly authorized central admin action, recorded in the audit trail.
5. NULL means inherit the next applicable layer; it must never silently mean unlimited when a stricter layer exists.

Keep session_lease_seconds distinct from operation permit duration. Migration 0007 adds operation_lease_seconds (default 300; 30–86400) and max_operation_lifetime_seconds (default 3600; 30–604800), with nullable account/product overrides. These are policy metadata only until the coordinator enforces them.

## Implementation gates

1. Coordinator state machine and an internal DO class are implemented on the feature branch. The state machine enforces both product-wide capacity and per-account capacity within a product-scoped coordinator. Queue entries preserve their own account cap so one account's override cannot change another account's queued admission. Wrangler binding and SQLite migration are declared only to provision local test runtime; no public Worker route invokes the namespace. Do not deploy or run remote migrations.
2. Cloudflare-runtime Vitest tests cover actual DO storage transactions, persistence across stubs, concurrent capacity, FIFO promotion, heartbeat, release, scope mismatch, and bad signatures. Alarm-based cleanup now stores the effective coordinator policy, schedules the earliest lease/queue deadline, expires leases and promotes waiters in `alarm()`, then schedules the next deadline. The alarm test forces an expired lease and invokes the scheduled alarm with the Cloudflare test helper. The Node-only storage harness also implements the storage alarm methods so legacy unit tests continue to exercise the coordinator without a real runtime.
3. Worker-side policy resolver, signed assertions, and authenticated acquire/heartbeat/release routes are implemented and tested. Product-wide and account-specific concurrency/queue caps are resolved separately.
4. Add adapters to STEEL, UTM, TASBIH and other product backends; demonstrate permit release in finally and heartbeat for long-running work.
5. Migration 0008 now defines account/product device registrations and hashed session-token leases with account/product foreign-key isolation. The registration/open/heartbeat/close/revoke APIs, atomic cap enforcement, and client device identity lifecycle remain pending; keep them separate from operation permits.
6. Run API tests, schema tests, and local D1/DO tests in CI.
7. Review Wrangler migration syntax and local binding behavior before any remote operation. Remote deployment and migration require separate explicit approval.

Do not set production concurrency caps until representative load tests are complete.

## Device/session lifecycle boundary

Device registration and session lifecycle are separate from operation admission. The Worker authenticates Firebase identity, resolves active account membership, and loads device/session policy independently from operation concurrency policy. Device and session ceilings are separate values; account overrides may tighten but cannot raise product policy.

The session-open statement conditionally inserts only when the installation is active and the account has fewer active, unexpired sessions than its configured cap. The returned 256-bit opaque token is shown once; the database stores only its SHA-256 hex digest. Heartbeats extend expiry only for an active, unexpired session attached to an active device. Closing a session revokes it, and revoking a device also revokes its active sessions.

Device IDs represent app installations, not proven physical hardware. Hardware attestation is not implemented. Missing device/session caps fail closed. This lifecycle is branch code only; no deployment or remote database migration has been performed, and product adapters remain pending.
