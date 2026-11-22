# الگوی اتصال هر محصول SAHROUD

این سند قرارداد لازم برای افزودن محصولات موجود و آینده به زیرساخت مرکزی است. مرجع دقیق محصولات و مسیرهای مخازن در [PORTFOLIO-INVENTORY.md](./PORTFOLIO-INVENTORY.md) قرار دارد؛ مرجع تخصیص سرویس‌های Cloudflare در [CLOUDFLARE-RESOURCE-MAP.md](./CLOUDFLARE-RESOURCE-MAP.md) است.

## ۱. شناسه ثابت محصول

هر محصول یک `product_key` یکتا دارد که پس از انتشار تغییر نمی‌کند. فهرست فعلی ۱۳ محصول است:

| محصول | product_key | دسته |
|---|---|---|
| FAMILY GUARD | family-guard | safety |
| STEEL | steel | engineering |
| METREH | metreh | construction |
| UTM | utm | surveying |
| GPS | gps | surveying |
| RTK | rtk | surveying |
| EARTH | earth | surveying |
| TOPOGRAPHY | topography | surveying |
| TASBIH | tasbih | utility |
| RAKAT | rakat | utility |
| COUNTER | counter | analytics |
| GAMES | games | games |
| WINDOWS DOCTOR | windows-doctor | desktop-utility |

شناسه `product_key` از طرف کلاینت قابل تغییر نیست و برای ثبت محصول جدید باید migration تازه ساخته شود. migration اجراشده را ویرایش نکنید.

## ۲. انتخاب دیتابیس و نام‌گذاری منابع

برای هر محصول، ابتدا سطح حساسیت، حجم، نرخ نوشتن، نیاز بازیابی و سهمیه D1 حساب بررسی می‌شود.

- Worker مرکزی: `sahroud-central-api`
- D1 مرکزی: `sahroud-central` با binding برابر `CORE_DB`
- Worker محصول در صورت نیاز: `sahroud-<product>-api`
- D1 اختصاصی محصول در صورت نیاز: `sahroud-<product>`
- Pages پنل محصول: `sahroud-<product>-dashboard`
- D1 اشتراکی کم‌حساسیت فقط به‌صورت رزرو: `sahroud-products-pool-01`

قواعد تخصیص:

1. داده حساس یا پرحجم باید در D1 اختصاصی محصول بماند. نمونه روشن: موقعیت و تاریخچه مکان FAMILY GUARD.
2. محصولات کم‌حساسیت فقط پس از طراحی و آزمون جداسازی می‌توانند در D1 اشتراکی قرار گیرند.
3. در D1 اشتراکی، تمام ردیف‌ها باید `product_key` و `account_id` داشته باشند و تمام queryها در Worker با هر دو مقدار محدود شوند.
4. شناسه حساب از هویت تأییدشده سمت سرور استخراج می‌شود؛ شناسه ارسالی کلاینت مجوز دسترسی نیست.
5. برای هر کاربر، خانواده، دستگاه یا پروژه D1 جدا نسازید.
6. D1 مرکزی فقط برای حساب، هویت، عضویت، کاتالوگ، اشتراک و مجوز است؛ محل داده عملیاتی هیچ محصولی نیست.
7. سرویس آمار رضایت‌محور موجود `sahroud-counter` مشترک باقی می‌ماند؛ برای هر اپ، Worker یا D1 آمار تکراری نسازید.
8. سهمیه D1 حساب رایگان ۱۰ دیتابیس در کل حساب است. پیش از هر ایجاد دیتابیس، موجودی واقعی حساب را بررسی کنید.

## ۳. جداسازی داده و چندمستاجری

- داده مکان، سلامت، مهندسی، نقشه و فایل خصوصی هرگز در D1 مرکزی ذخیره نشود.
- همه queryهای چندمستاجری باید هم `product_key` و هم `account_id` را محدود کنند.
- این دو مقدار باید از هویت تأییدشده سمت Worker به دست آیند، نه از پارامتر قابل‌دستکاری کلاینت.
- هیچ مسیر مستقیمی از مرورگر یا APK به D1 داده نشود.
- آزمون منفی برای تلاش دسترسی حساب یا محصول دیگر نوشته شود.
- D1 خودش Row-Level Security خودکار ارائه نمی‌کند؛ جداسازی در لایه Worker باید کامل و آزموده باشد.

## ۴. اتصال کلاینت به کاتالوگ مرکزی

آدرس API از تنظیمات محیطی برنامه دریافت شود؛ URL تولید را در چند فایل یا نسخه اپ کپی نکنید.

مسیرهای عمومی فعلی:

- `GET /health`
- `GET /v1/version`
- `GET /v1/catalog/products`
- `GET /v1/catalog/products/{product_key}`

نمونه درخواست:

    const response = await fetch(CENTRAL_API_BASE + "/v1/catalog/products");
    if (!response.ok) throw new Error("SAHROUD Central is unavailable");
    const catalog = await response.json();

این مسیرها فقط داده عمومی کاتالوگ را می‌دهند. احراز هویت، مدیریت حساب، صدور مجوز و اشتراک هنوز فعال نیستند؛ هیچ محصولی نباید دسترسی تجاری را با پاسخ ساختگی یا کلید ثابت داخل برنامه فعال کند.

## ۵. Cloudflare Pages و Workers در monorepo

برای Worker:
- Repository: `sahroud/danky`
- Root directory: مسیر دقیق Worker، برای هسته مرکزی `/platform`
- Build command: خالی، مگر آنکه build خاصی لازم باشد
- Deploy command: `npm run deploy`
- Worker name: دقیقاً برابر `name` در فایل `wrangler.toml` همان پوشه باشد
- Build watch paths فقط مسیرهای همان Worker را شامل شود.

برای Pages:
- Repository: مخزن محصول
- Build command: خالی برای پنل HTML ایستا
- Build output directory: مسیر دقیق پنل محصول
- Root directory و Build output را با هم دوباره‌شماری نکنید.
- لینک‌های قدیمی GitHub Pages تا زمان مهاجرت کنترل‌شده حفظ شوند؛ استفاده از Cloudflare Workers به معنی انتقال اجباری رابط به Pages نیست.

## ۶. CORS و اسرار

- Origin دقیق پنل‌های وب در `CORS_ALLOWED_ORIGINS` ثبت شود؛ wildcard مجاز نیست.
- CORS جایگزین احراز هویت یا کنترل مجوز نیست.
- کلاینت Android ممکن است Origin نداشته باشد؛ API باید توکن و مجوز واقعی را سمت سرور بررسی کند.
- Secretها فقط در Cloudflare Variables & Secrets نگهداری شوند، نه در GitHub، APK یا JavaScript مرورگر.
- نام متغیرهای legacy سرویس‌های مستقر را بدون مهاجرت هماهنگ تغییر ندهید.

## ۷. چک‌لیست پیش از تولید

- شناسه محصول یکتا و در کاتالوگ ثبت شده باشد.
- سطح حساسیت و محل ذخیره داده تعیین شده باشد.
- جداسازی `product_key` و `account_id` در تمام queryها اجرا و آزمون شده باشد.
- migration در محیط محلی یا staging اجرا و آزمون شود.
- Secret در Variables & Secrets تنظیم شود، نه در Git.
- CORS با Origin واقعی محدود شود.
- داده قدیمی به‌عنوان داده زنده نمایش داده نشود.
- توقف/لغو/حذف و سیاست نگهداری داده تعریف شود.
- آزمون خودکار، حریم خصوصی، چندحسابی، بازیابی و بار متناسب با هدف اجرا شود.
