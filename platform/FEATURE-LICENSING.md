# SAHROUD CENTRAL feature licensing

This branch adds feature-level access control to the central control plane.

## Data model

- `product_features`: one row per independently controlled feature. `access_mode` is `free`, `paid`, or `disabled`; `is_enabled=0` blocks all users.
- `account_feature_grants`: account-scoped paid, trial, promotional, or manually granted access, with optional start/end dates and usage limits.
- `plan_features`: maps product plans to the features included in each plan.
- `audit_events`: records feature-setting changes.

Product operational data remains in each product's own database. Only identity, catalog, plans, grants, and licensing policy live in the central D1 database.

## API

All authenticated endpoints require a Firebase ID token in `Authorization: Bearer <token>`.

- `GET /v1/admin/products/{productKey}/features` — list feature settings; central administrators only.
- `POST /v1/admin/products/{productKey}/features/{featureKey}` — create/update a feature; central administrators only.
- `GET /v1/access/{productKey}/{featureKey}` — evaluate the current account's access to one feature.

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

Set `access_mode` to `free` for free access or `disabled` to block everyone. Set `is_enabled=false` as an additional global kill switch. Free features must have `price_amount: null`.

## Administrator protection

Set the Cloudflare Worker environment variable `CENTRAL_ADMIN_UIDS` to a comma-separated allowlist of Firebase Authentication user UIDs. Do not use email addresses or expose this setting in frontend code. Only those Firebase identities can access the admin API.

## Deployment sequence

1. Review this branch and run the platform tests.
2. Apply migration 0003 to the central D1 database only:
   `npx wrangler d1 migrations apply sahroud-central --remote`
3. Configure `CENTRAL_ADMIN_UIDS` as a Worker secret or protected environment variable.
4. Deploy the Worker.
5. Test feature listing, admin update, free access, paid denial, grant acceptance, and disabled denial.
6. Connect each product's UI to the access endpoint and also enforce the same policy on protected server operations.

Never apply this migration to `sahroud-family-guard`. Do not rely on hiding buttons in the browser: each paid operation must be checked by a trusted server endpoint before execution.
