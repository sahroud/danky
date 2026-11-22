# راه‌اندازی اولیه SAHROUD Central در Cloudflare

این راهنما فقط برای هسته مرکزی مشترک است. دیتابیس FAMILY GUARD و دیتابیس‌های سایر محصولات را به‌جای D1 مرکزی انتخاب نکنید. قبل از ایجاد هر منبع، نقشه [CLOUDFLARE-RESOURCE-MAP.md](./CLOUDFLARE-RESOURCE-MAP.md) را بخوانید.

## آدرس‌های رسمی پنل

- D1 SQL database: https://dash.cloudflare.com/?to=/:account/workers/d1
- Workers & Pages: https://dash.cloudflare.com/?to=/:account/workers-and-pages

این مسیرها با پیوندهای ارائه‌شده در راهنمای رسمی Cloudflare بررسی شده‌اند:
- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/learning-paths/workers/get-started/first-worker/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

## مرحله صفر — بررسی ظرفیت و جلوگیری از تکرار

قبل از ساخت دیتابیس یا Worker:
1. صفحه رسمی D1 SQL database را باز کنید: https://dash.cloudflare.com/?to=/:account/workers/d1
2. فهرست دیتابیس‌های حساب و تعداد آن‌ها را بررسی کنید؛ نام، شناسه، اندازه و bindingهای مرتبط را یادداشت کنید.
3. صفحه Workers & Pages را باز کنید: https://dash.cloudflare.com/?to=/:account/workers-and-pages
4. بخش‌های Workers و Pages را جداگانه بررسی کنید.
5. اگر `sahroud-central` یا `sahroud-central-api` وجود دارد، آن را دوباره نسازید؛ شناسه، binding و وضعیت را بررسی کنید.
6. نام‌های `sahroud-counter` و `sahroud-family-guard` در پیکربندی محصولات موجود آمده‌اند؛ آن‌ها را هم در موجودی حساب پیدا کنید و دوباره ایجاد نکنید.
7. فقط پس از تهیه موجودی کامل و بررسی ظرفیت، درباره ساخت منبع مرکزی تصمیم بگیرید.

در طرح رایگان D1 حداکثر ۱۰ دیتابیس در کل حساب، حداکثر ۵۰۰ مگابایت برای هر دیتابیس و مجموعاً ۵ گیگابایت فضای D1 وجود دارد. سقف خواندن و نوشتن روزانه نیز محدود است و در صورت عبور، درخواست‌های D1 تا نیمه‌شب UTC با خطا مواجه می‌شوند. منابع سایر محصولات نیز از همین سهمیه استفاده می‌کنند.

## مرحله اول — ساخت پایگاه داده مرکزی

فقط اگر در مرحله صفر نبود آن را تأیید کردید:
- Database name: `sahroud-central`
- Worker binding: `CORE_DB`

پس از ساخت، Database ID را در محل امن پروژه ثبت کنید. Database ID رمز یا API Token نیست؛ با این حال فقط در پیکربندی همان Worker قرار گیرد. هیچ Cloudflare API Token یا Secret را در Git قرار ندهید.

فایل migration پایه:
https://github.com/sahroud/danky/blob/feat/sahroud-central-foundation/platform/migrations/0001_core.sql

فایل تکمیل فهرست محصولات:
https://github.com/sahroud/danky/blob/feat/sahroud-central-foundation/platform/migrations/0002_portfolio_products.sql

## مرحله دوم — اتصال Worker مرکزی به D1

Worker name:
- `sahroud-central-api`

اگر Worker از قبل وجود دارد، همان را انتخاب کنید. در صفحه Worker به زبانه `Bindings` بروید، `Add binding` را بزنید، نوع `D1 database` را انتخاب کنید، در `Variable name` دقیقاً `CORE_DB` را وارد و دیتابیس `sahroud-central` را انتخاب کنید.

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

## مرحله سوم — Workers Builds و استقرار کنترل‌شده

تنظیمات ساخت در صفحه Worker و بخش `Settings > Build` قرار دارد: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

مقادیر پروژه: مخزن `sahroud/danky`، شاخه تولید `main` فقط پس از ادغام PR، Root directory برابر `/platform`، Build command خالی و Deploy command برابر `npm run deploy` است.

PR هسته مرکزی فعلاً Draft است؛ آن را برای استقرار تولیدی به `main` وصل نکنید. پس از تأیید موجودی Cloudflare و موفقیت استقرار آزمایشی، آن را برای ادغام آماده می‌کنیم.

## مرحله چهارم — اجرای migrationهای نسخه‌دار

روش استاندارد، اجرای migrationهای موجود با Wrangler و ثبت نسخه اجراشده در D1 است. فایل migration اجراشده را ویرایش نکنید؛ برای تغییرات بعدی migration با شماره جدید بسازید.

از پوشه `platform`:
- `npm install`
- `npm run db:migrate:remote`

برای آزمون محلی:
- `npm run db:migrate:local`

اجرای موفق دو migration فعلی باید جدول‌های `principals`, `accounts`, `account_identities`, `account_memberships`, `products`, `plans`, `subscriptions`, `entitlements`, `license_keys` و `audit_events` را ایجاد و ۱۳ محصول را در کاتالوگ ثبت کند.

## مرحله پنجم — اتصال و بررسی سرویس

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
