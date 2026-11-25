# Runtime Admission Coordinator Design

Status: Durable Object class and unit-level signed-assertion/persistence tests are implemented on the feature branch. The Wrangler namespace binding, Worker-side policy resolver/signer, product-backend integration, Cloudflare-runtime DO tests, and deployment remain disabled/not implemented. No deployment has occurred.

## Safety boundary

The central Worker is the only public entry point. It authenticates the Firebase identity, resolves the selected central account, loads the effective policy, and then invokes an internal Durable Object (DO) coordinator. Clients must never receive a DO stub or be allowed to call a coordinator endpoint directly.

This work is limited to the SAHROUD CENTRAL control plane. Do not bind, migrate, query, or modify the SAHROUD FAMILY GUARD operational database. No remote migration or Worker deployment is authorized by this design.

## Admission scopes

Keep these independent:
- Registered devices per account/product.
- Active authenticated sessions per account/product.
- Active heavy operations per product (global product capacity).
- Active heavy operations per account/product (fairness and account-level caps).
- Bounded waiting queue and maximum wait duration.

A device registration is not a session, and a session is not an operation permit. Do not treat a client-supplied device label or fingerprint as proof of device identity.

## Coordinator placement

Use a Durable Object with serialized state transitions. A deterministic, opaque DO name is derived by the Worker from the scope (for example, product scope for global capacity and account+product scope for account limits). Never accept arbitrary DO names from clients.

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

1. Coordinator state machine and an internal DO class are implemented on the feature branch. Its namespace is deliberately not bound yet; unit tests use a serialized storage harness. Do not deploy.
2. Next add Cloudflare-runtime Vitest tests for the actual DO storage transaction, alarm/restart behavior, queue overflow/FIFO, idempotency, expiry, heartbeat, release, revoke, scope mismatch, bad signatures, and policy reductions before enabling a Wrangler binding.
3. Add a worker-side policy resolver and signed assertion; test malformed/missing/stale assertions.
4. Add a test-only adapter for product backends and demonstrate permit release in finally.
5. Run API tests, schema tests, and local D1/DO tests in CI.
6. Review Wrangler migration syntax and local binding behavior before any remote operation. Remote deployment and migration require separate explicit approval.

Do not set production concurrency caps until representative load tests are complete.