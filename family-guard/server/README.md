# SAHROUD FAMILY GUARD — API foundation

This is the first server-side foundation for a consent-based family location service.
It is separate from the existing camera app and does not change the step-counter code.

## Included endpoints

- `GET /health` — service health check.
- `POST /v1/families` — create a family and return a one-time parent bearer token.
- `POST /v1/invites` — parent creates a single-use pairing code (10-minute expiry).
- `POST /v1/devices/pair` — member pairs a device only after explicitly accepting consent.
- `POST /v1/location` — consented device submits validated coordinates.
- `GET /v1/family/devices` — parent retrieves registered devices and last known locations.
- `POST /v1/devices/sharing/stop` — device owner stops sharing.
- `POST /v1/family/devices/{device_id}/revoke` — parent revokes that device's sharing access.

Bearer tokens are random, returned once, and stored in D1 only as SHA-256 hashes.
Pairing codes are single-use and expire after ten minutes. Location responses include
both the device's recorded time and server receive time; clients must never label stale
coordinates as live. The member-facing app must visibly show sharing state and provide
a stop control.

## Deploy outline

1. Install Node.js and Wrangler on a computer.
2. From this directory run `npx wrangler d1 create sahroud-family-guard`.
3. Copy the returned database ID into `wrangler.toml`.
4. Run `npx wrangler d1 execute sahroud-family-guard --remote --file=schema.sql`.
5. Set `ALLOWED_ORIGIN` to the exact deployed dashboard origin (not `*`).
6. Run `npx wrangler deploy`.
7. Test `GET https://YOUR-WORKER.workers.dev/health`.

Do not publish parent or device bearer tokens. Store them only in secure device storage
when the Android client integration is implemented. Do not place secrets in GitHub source.

## Important current limitations

This is an API foundation, not a completed parental-control product. It does not yet
include a parent dashboard, Android pairing screens, secure token storage in Android,
background upload integration, route-history UI, account recovery, data export/deletion
controls, or production abuse/rate-limit monitoring. Add Cloudflare rate limiting and
operational monitoring before public launch. The parent token currently grants access to
the family; production deployment should add a proper parent login/recovery flow and
token rotation. No health metrics or step-count data are uploaded by this API.
