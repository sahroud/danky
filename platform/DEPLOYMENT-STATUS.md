# وضعیت استقرار SAHROUD CENTRAL

**آخرین بازبینی:** ۲۳ نوامبر ۲۰۲۶  
**مخزن:** `sahroud/danky`  
**شاخه:** `feat/sahroud-central-foundation`  
**Pull Request:** [#1 — Draft](https://github.com/sahroud/danky/pull/1)

این سند فقط وضعیت‌هایی را ثبت می‌کند که با خروجی واقعی ابزارها یا آزمون‌های ثبت‌شده تأیید شده‌اند. وجود کد در مخزن به‌تنهایی به معنی فعال بودن قابلیت در سرویس نیست.

## منابع راه‌دور تأییدشده

| مورد | مقدار | وضعیت |
|---|---|---|
| Cloudflare Worker | `sahroud-central-api` | مستقر و پاسخ‌گو |
| نشانی عمومی Worker | `https://sahroud-central-api.sahroud.workers.dev` | تأییدشده |
| نسخه مستقر Worker | `84501bd4-745e-4ba2-856b-86ac0dcdd5b7` | تأییدشده |
| D1 مرکزی | `sahroud-central` | اتصال موفق |
| D1 ID | `f4824106-b05c-4d15-b131-dd943b08ff14` | تأییدشده |
| Binding | `CORE_DB` → `sahroud-central` | تأییدشده |
| CORS origin | `https://sahroud.github.io` | تأییدشده با GET و OPTIONS |

**مرزبندی حیاتی:** دیتابیس `sahroud-family-guard` با شناسه `c66275c9-b0a7-4925-8434-4f1c409ca132` منبعی مستقل است و نباید با migration یا تنظیمات هسته مرکزی تغییر کند. داده‌های مکان و مسیر FAMILY GUARD در همان محصول باقی می‌مانند.

## Migration و کاتالوگ

- `0001_core.sql` روی D1 مرکزی اجرا شده است.
- `0002_portfolio_products.sql` روی D1 مرکزی اجرا شده است.
- بررسی فهرست migrationهای راه‌دور پیام `No migrations to apply!` داده است.
- کاتالوگ زنده شامل ۱۳ محصول است.
- وضعیت هر ۱۳ محصول در کاتالوگ فعلی `development` است؛ این مقدار به معنی انتشار تجاری یا فعال بودن مجوز محصول نیست.

## آزمون‌های تأییدشده

| آزمون | نتیجه |
|---|---|
| `GET /health` | HTTP 200؛ `status=ok` و `core_db=ok` |
| `GET /v1/version` | پاسخ نسخه `0.2.0` |
| `GET /v1/catalog/products` | دریافت ۱۳ محصول از D1 |
| CORS GET با Origin مجاز | HTTP 200 و `Access-Control-Allow-Origin` دقیق |
| CORS preflight با OPTIONS | HTTP 204 و هدرهای مجاز |
| تست‌های Node.js | ۲۱ تست موفق در اجرای محلی ثبت‌شده |
| GitHub Actions | اجرای CI شماره ۳۲ با نتیجه `success`؛ آزمون API و اعتبارسنجی migration |

آزمون curl از بیرون Worker، پاسخ واقعی هدرهای CORS را بررسی کرده است. باز شدن مستقیم URL در نوار نشانی مرورگر به‌تنهایی آزمون CORS نیست.

## احراز هویت در شاخه توسعه — پیاده‌سازی شده، هنوز پیکربندی/مستقر نشده

- Firebase Authentication برای دو روش Google (`google.com`) و SMS Phone (`phone`) انتخاب شده است.
- Worker شاخه توسعه اکنون توکن Firebase ID را با امضای RS256 و کلیدهای رسمی Firebase، `aud`, `iss`, `exp`, `iat`, `auth_time` و provider مجاز بررسی می‌کند.
- `POST /v1/auth/session` هویت تأییدشده را به principal و حساب شخصی مرکزی متصل می‌کند؛ `GET /v1/me` اطلاعات حساب مرکزی را برمی‌گرداند.
- کلاینت مشترک و adapter وب، ورود Google، ورود پیامکی و پیوند provider دوم به همان Firebase UID را پشتیبانی می‌کنند.
- آزمون‌های واحد برای مسیرهای احراز هویت، هدرهای Bearer، reCAPTCHA adapter و اعتبارسنجی ورودی افزوده شده‌اند.
- `FIREBASE_PROJECT_ID` هنوز در Cloudflare تنظیم نشده و پروژه Firebase هنوز از سوی کاربر تأیید/پیکربندی نشده است؛ endpoint به همین دلیل در محیط فعلی غیرفعال می‌ماند.
- SMS در Firebase نیازمند طرح Blaze و هزینه به‌ازای هر پیامک است؛ تا تأیید آگاهانه هزینه، Phone Auth واقعی فعال نمی‌شود.

## قابلیت‌هایی که هنوز فعال نشده‌اند

- ورود واقعی در محیط تولید تا ثبت Project ID و آزمایش Google/SMS
- ثبت و مدیریت دستگاه‌ها
- نشست مستقل SAHROUD و خروج/ابطال مرکزی
- نقش‌ها و کنترل دسترسی کامل چندحسابی برای APIهای محصولات
- صدور، اعتبارسنجی و ابطال مجوز نرم‌افزار
- طرح‌ها، اشتراک‌ها و پرداخت
- پنل مدیریت مرکزی

CORS احراز هویت نیست. توکن Firebase فقط در هدر Authorization استفاده می‌شود و در D1 یا localStorage ذخیره نمی‌شود. هنوز هیچ migration راه‌دور برای احراز هویت اجرا نشده است.

## وضعیت GitHub و انتشار

- تغییر CORS در commit `8c5ca98cfaf1449270b1c53d0fb5858410e0fd45` روی شاخه توسعه ثبت شده است.
- PR شماره ۱ هنوز Draft است و Merge نشده است.
- در زمان این بازبینی، شاخه نسبت به `main` دارای ۲۲ commit جلوتر و ۵۶ commit عقب‌تر گزارش شده است؛ بنابراین ادغام مستقیم بدون بررسی و همگام‌سازی می‌تواند تغییرات نامرتبط مخزن را وارد کند.
- وضعیت فایل‌های محلی یا تغییرات commit‌نشده روی لپ‌تاپ از راه دور قابل مشاهده نیست؛ فقط فایل‌های commit‌شده GitHub و نسخه Worker مستقر قابل تأییدند.

## گام بعدی

1. ساخت/انتخاب پروژه Firebase و فعال‌سازی Google provider.
2. افزودن دامنه‌های واقعی برنامه‌ها به Authorized domains.
3. ثبت `FIREBASE_PROJECT_ID` در تنظیمات Worker و Deploy نسخه جدید.
4. آزمایش ورود Google و پیوند امن شماره موبایل به همان Firebase UID.
5. فقط پس از بررسی هزینه و تأیید کاربر، فعال‌سازی SMS و آزمون پیامک واقعی.
6. تکمیل مدیریت دستگاه، نشست مرکزی، نقش‌ها و مجوز محصول.

راهنمای دقیق: [FIREBASE-AUTH-SETUP.md](./FIREBASE-AUTH-SETUP.md).
