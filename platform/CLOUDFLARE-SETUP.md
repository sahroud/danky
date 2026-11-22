# راه‌اندازی اولیه SAHROUD Central در Cloudflare

این راهنما فقط برای هسته مرکزی مشترک است. دیتابیس FAMILY GUARD و دیتابیس‌های سایر محصولات را به‌جای D1 مرکزی انتخاب نکنید.

## مرحله صفر — بررسی ظرفیت حساب

قبل از ساخت دیتابیس:
1. وارد Cloudflare شوید: https://dash.cloudflare.com
2. از منوی Storage & databases بخش D1 SQL Database را باز کنید.
3. تعداد دیتابیس‌های موجود حساب را بررسی کنید.
4. اگر دیتابیسی با نام sahroud-central وجود دارد، آن را دوباره نسازید؛ مالکیت و وضعیت آن را بررسی کنید.
5. اگر نام وجود ندارد، فقط در صورت وجود ظرفیت سهمیه آن را بسازید.

در طرح رایگان D1 حداکثر ۱۰ دیتابیس در کل حساب، حداکثر ۵۰۰ مگابایت برای هر دیتابیس و مجموعاً ۵ گیگابایت فضای D1 وجود دارد. دیتابیس‌های موجود سایر محصولات نیز از همین سهمیه استفاده می‌کنند.

## مرحله اول — ساخت پایگاه داده مرکزی

نام دقیق:
- Database name: sahroud-central
- Worker binding: CORE_DB

پس از ساخت، Database ID را کپی کنید. Database ID به‌تنهایی رمز یا API token نیست، اما باید فقط در فایل پیکربندی همان Worker قرار بگیرد. هیچ Cloudflare API Token یا Secret را در Git قرار ندهید.

فایل migration:
https://github.com/sahroud/danky/blob/feat/sahroud-central-foundation/platform/migrations/0001_core.sql

## مرحله دوم — پیکربندی Worker

Worker name:
- sahroud-central-api

مخزن:
- sahroud/danky

مسیر پروژه:
- Root directory: /platform

تنظیم استقرار:
- Build command: خالی
- Deploy command: npm run deploy

فایل پیکربندی:
- platform/wrangler.toml

در فایل پیکربندی، placeholder مربوط به database_id را با Database ID پایگاه sahroud-central جایگزین کنید. این مقدار باید در محیط پیکربندی Wrangler باشد، نه در کد HTML برنامه‌ها.

Cloudflare Workers Builds:
https://developers.cloudflare.com/workers/ci-cd/builds/

راهنمای تنظیم Root directory:
https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

## مرحله سوم — ثبت migration

روش استاندارد این پروژه، اجرای migration با Wrangler و ثبت نسخه آن در جدول migrationهای D1 است؛ فایل migration اجراشده را بعداً ویرایش نکنید و برای همان نسخه دوباره فایل جدا نسازید.

از پوشه platform اجرا کنید:
- npm install
- npm run db:migrate:remote

در صورت استفاده از محیط محلی:
- npm run db:migrate:local

اجرای موفق باید جدول‌های principals، accounts، account_identities، account_memberships، products، plans، subscriptions، entitlements، license_keys و audit_events را ایجاد کند.

## مرحله چهارم — بررسی سرویس

پس از Deploy، آدرس Worker معمولاً به شکل زیر است:
https://sahroud-central-api.<ACCOUNT_SUBDOMAIN>.workers.dev

این فقط الگوی نشانی است؛ مقدار واقعی را از Cloudflare پس از Deploy بردارید و حدس نزنید.

آزمون‌ها:
- GET /health باید status برابر ok و dependencies.core_db برابر ok برگرداند.
- GET /v1/version باید api_version برابر 0.2.0 را برگرداند.
- GET /v1/catalog/products باید شش محصول ثبت‌شده را از D1 برگرداند.

## نکات مهم

- در این مرحله فقط یک D1 مرکزی ساخته می‌شود؛ دیتابیس Remote staging جداگانه تا زمان بررسی سهمیه ایجاد نشود.
- آزمون‌های محلی با D1 محلی Wrangler انجام می‌شوند.
- API مرکزی فعلی فقط خواندنی است؛ ورود، مدیریت حساب، صدور مجوز و پرداخت هنوز فعال نیستند.
- migration مرکزی هیچ ارتباطی با migrationهای موجود FAMILY GUARD ندارد.
- هیچ migration مرکزی را روی D1 محصول دیگری اجرا نکنید.
- قبل از افزودن قابلیت نوشتن یا اتصال تجاری، احراز هویت، rate limiting، کنترل نقش، audit و بازیابی باید تکمیل شوند.
