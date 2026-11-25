# SAHROUD CENTRAL commerce lifecycle

## Scope

Migration 0005 adds a provider-neutral data model for checkout orders, payment attempts, and webhook event deduplication. It does not activate an online payment gateway and does not change any remote database.

## Data model

- `checkout_orders`: account/product/plan, order type, amount/currency, lifecycle status, expiry, provider reference, and an account-scoped idempotency key.
- `payment_attempts`: each redirect/authorization/capture/failure attempt and the provider's payment reference.
- `payment_webhook_events`: unique provider event IDs, payload digest, and processing outcome. Duplicate webhook delivery is rejected by a unique constraint.
- Existing `subscriptions` remain the entitlement record. A payment event must never grant access merely because a browser returned to a success URL.

## Required payment adapter contract

A provider adapter must implement:
1. Create a checkout session from a server-calculated order amount and currency.
2. Verify webhook authenticity using the provider's documented signature scheme and a secret stored only in Worker secrets.
3. Normalize provider events into a small internal set: payment pending, captured, failed, cancelled, refunded.
4. Persist provider event IDs before processing, and process each event idempotently.
5. Reconcile ambiguous timeouts by querying the provider server-to-server before retrying or issuing an entitlement.

Only a verified captured/settled payment may mark an order paid and issue/extend its subscription or feature grant. The order update, payment attempt update, entitlement change, and audit record must be atomic where possible. Refunds and chargebacks must trigger a corresponding entitlement review/revocation policy.

## Still required before real sales

- Select and verify a payment provider that legally supports the merchant and intended country.
- Implement provider-specific checkout creation and webhook signature verification.
- Add authenticated customer checkout/order-status endpoints and admin refund/reconciliation tools.
- Add expiry/renewal jobs and customer cancellation flows.
- Test duplicate, delayed, out-of-order, forged, and replayed webhooks.
- Connect each product's trusted backend to the central access check before enabling paid operations.

Do not put provider credentials in Git, HTML, browser JavaScript, APK files, or D1. Configure them only as protected Worker secrets. Do not deploy or apply migration 0005 to any remote D1 database without explicit approval. Never apply it to `sahroud-family-guard`.
