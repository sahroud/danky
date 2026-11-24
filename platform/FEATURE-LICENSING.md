# SAHROUD CENTRAL feature licensing

This branch adds feature-level access control to the central control plane.

## Data model

- `product_features`: one row per independently controlled feature. `access_mode` is `free`, `paid`, or `disabled`; `is_enabled=0` blocks all users.
- `account_feature_grants`: account-scoped paid, trial, promotional, or manually granted access, with optional start/end dates and usage limits.
- `plan_features`: maps product plans to the features included in each plan.
- `feature_usage`: lifetime usage totals per account/product/feature; changing from a grant to a plan does not reset the counter.
- `audit_events`: records feature-setting changes.

Product operational data remains in each product's own database. Only identity, catalog, plans, grants, and licensing policy live in the central D1 database.

## API

All authenticated endpoints require a Firebase ID token in `Authorization: Bearer <token>`.

- `GET /v1/admin/products/{productKey}/features` — list feature settings; central administrators only.
- `POST /v1/admin/products/{productKey}/features/{featureKey}` — create/update a feature; central administrators only.
- `GET /v1/access/{productKey}/{featureKey}` — evaluate access and return usage remaining; does not consume a use.
- `POST /v1/access/{productKey}/{featureKey}/consume` — atomically consume one use after the protected operation has been authorized by its trusted server.

POST JSON example:

```json
{
  "display_name": "DXF export",
  "description": "Export survey results to DXF",
  "is_enabled": true,
  "access_mode": "paid",
  "price_amount": 250000,
  "currency": "IRR",
  "trial_days": 0,
  "usage_limit": null
}
```

Set `access_mode` to `free` for free access or `disabled` to block everyone. Set `is_enabled=false` as an additional global kill switch. Free features must have `price_amount: null`. A paid feature is allowed by either an active feature grant or an active subscription whose plan includes that feature in `plan_features`.

`usage_limit` is a lifetime limit per account and feature in this first version (not a daily or monthly quota). A grant-specific `usage_limit`, when present, overrides the feature default. The consume endpoint increments the counter atomically so simultaneous requests cannot exceed the configured limit. Product backends must invoke the consume check as part of the protected operation; calling it only from browser JavaScript is not a security boundary.

## Administrator protection

Set the Cloudflare Worker environment variable `CENTRAL_ADMIN_UIDS` to a comma-separated allowlist of Firebase Authentication user UIDs. Do not use email addresses or expose this setting in frontend code. Only those Firebase identities can access the admin API.

## Deployment sequence

1. Review this branch and run the platform tests.
2. Apply migration 0003 to the central D1 database only:
   `npx wrangler d1 migrations apply sahroud-central --remote`
3. Configure `CENTRAL_ADMIN_UIDS` as a Worker secret or protected environment variable.
4. Deploy the Worker.
5. Test feature listing, admin update, free access, paid denial, grant acceptance, subscription-plan acceptance, disabled denial, and concurrent usage-limit enforcement.
6. Connect each product backend to the access and consume checks before enabling paid operations; then build the central administrator UI.

Never apply this migration to `sahroud-family-guard`. Do not rely on hiding buttons in the browser: each paid operation must be checked by a trusted server endpoint before execution.

For users who belong to multiple central accounts, feature access requires the `X-Sahroud-Account-Id` request header. The API validates that the signed-in principal has an active membership in that account. If the header is omitted and the user has more than one active account, the API returns `account_selection_required` rather than silently charging or consuming usage against an arbitrary account.
