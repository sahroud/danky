# راه‌اندازی اولیه SAHROUD Central در Cloudflare

این راهنما فقط برای هسته مرکزی مشترک است. دیتابیس FAMILY GUARD و دیتابیس‌های سایر محصولات را به‌جای D1 مرکزی انتخاب نکنید. قبل از ایجاد هر منبع، نقشه [CLOUDFLARE-RESOURCE-MAP.md](./CLOUDFLARE-RESOURCE-MAP.md) را بخوانید.

## مرحله صفر — بررسی ظرفیت و جلوگیری از تکرار

قبل از ساخت دیتابیس یا Worker:
1. وارد https://dash.cloudflare.com شوید.
2. از Storage & databases > D1 SQL Database فهرست و تعداد D1های حساب را بررسی کنید.
3. از Workers & Pages فهرست Workerها و Pages را بررسی کنید.
4. اگر `sahroud-central` یا `sahroud-central-api` وجود دارد، آن را دوباره نسازید؛ شناسه، binding و وضعیت را بررسی کنید.
5. اگر نام وجود ندارد، فقط در صورت وجود ظرفیت سهمیه آن را بسازید.
6. نام‌های `sahroud-counter` و `sahroud-family-guard` در پیکربندی محصولات موجود آمده‌اند؛ آن‌ها را در موجودی حساب پیدا کنید و دوباره ایجاد نکنید.

در طرح رایگان D1 حداکثر ۱۰ دیتابیس در کل حساب، حداکثر ۵۰۰ مگابایت برای هر دیتابیس و مجموعاً ۵ گیگابایت فضای D1 وجود دارد. این سقف شامل دیتابیس‌های سایر محصولات نیز می‌شود.

## مرحله اول — ساخت پایگاه داده مرکزی

فقط اگر در مرحله صفر نبود آن را تأیید کردید:
- Database name: `sahroud-central`
- Worker binding: `CORE_DB`

پس از ساخت، Database ID را در محل امن پروژه ثبت کنید. Database ID رمز یا API Token نیست؛ با این حال فقط در پیکربندی همان Worker قرار گیرد. هیچ Cloudflare API Token یا Secret را در Git قرار ندهید.

فایل migration پایه:
https://github.com/sahroud/danky/blob/feat/sahroud-central-foundation/platform/migrations/0001_core.sql

فایل تکمیل فهرست محصولات:
https://github.com/sahroud/danky/blob/feat/sahroud-central-foundation/platform/migrations/0002_portfolio_products.sql

## مرحله دوم — پیکربندی Worker

Worker name:
- `sahroud-central-api`

مخزن:
- `sahroud/danky`

شاخه تولید:
- `main`، پس از ادغام تغییرات بررسی‌شده

مسیر پروژه:
- Root directory: `/platform`

تنظیم استقرار:
- Build command: خالی
- Deploy command: `npm run deploy`

فایل پیکربندی:
- `platform/wrangler.toml`

در فایل پیکربندی، placeholder مربوط به `database_id` را با شناسه واقعی D1 مرکزی جایگزین کنید. Cloudflare Workers Builds از تنظیمات Root directory و Deploy command پشتیبانی می‌کند:
https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

## مرحله سوم — اجرای migrationهای نسخه‌دار

روش استاندارد، اجرای migrationهای موجود با Wrangler و ثبت نسخه اجراشده در D1 است. فایل migration اجراشده را ویرایش نکنید؛ برای تغییرات بعدی migration با شماره جدید بسازید.

از پوشه `platform`:
- `npm install`
- `npm run db:migrate:remote`

برای آزمون محلی:
- `npm run db:migrate:local`

اجرای موفق دو migration فعلی باید جدول‌های `principals`, `accounts`, `account_identities`, `account_memberships`, `products`, `plans`, `subscriptions`, `entitlements`, `license_keys` و `audit_events` را ایجاد و ۱۳ محصول را در کاتالوگ ثبت کند.

## مرحله چهارم — اتصال و بررسی سرویس

پس از Deploy، آدرس واقعی Worker معمولاً به شکل زیر است:
`https://sahroud-central-api.<ACCOUNT_SUBDOMAIN>.workers.dev`

این فقط الگوی نشانی است؛ مقدار واقعی را از Cloudflare پس از Deploy بردارید و حدس نزنید.

آزمون‌ها:
- `GET /health` باید `status: ok` و `dependencies.core_db: ok` برگرداند.
- `GET /v1/version` باید `api_version: 0.2.0` برگرداند.
- `GET /v1/catalog/products` باید ۱۳ محصول ثبت‌شده را از D1 برگرداند.

## نکات مهم

- در مرحله اول فقط یک D1 مرکزی ساخته می‌شود؛ D1 راه‌دور staging جداگانه نسازید تا سهمیه حساب بررسی شود.
- آزمون‌های محلی با D1 محلی Wrangler انجام می‌شوند.
- API مرکزی در این نسخه فقط‌خواندنی است؛ ورود، مدیریت حساب، صدور مجوز و پرداخت هنوز فعال نیستند.
- migration مرکزی هیچ ارتباطی با migrationهای موجود FAMILY GUARD یا COUNTER ندارد. هیچ migration مرکزی را روی D1 محصول دیگری اجرا نکنید.
- قبل از فعال‌سازی endpointهای نوشتن، احراز هویت، کنترل نقش، rate limiting، audit و بازیابی باید تکمیل شوند.
