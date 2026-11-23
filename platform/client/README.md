# کتابخانه مشترک SAHROUD Central\n\nاین کتابخانه برای اتصال وب‌اپ‌های SAHROUD به API مرکزی است. فقط endpointهای عمومی و فقط‌خواندنی را فراخوانی می‌کند.\n\n## استفاده\n\nفایل `sahroud-central.js` را به برنامه وب اضافه کنید و از آن به‌صورت ES module استفاده کنید:\n\n    import { createSahroudCentralClient } from './sahroud-central.js';\n    const central = createSahroudCentralClient({\n      apiBase: window.SAHROUD_CONFIG.centralApiBase\n    });\n    const health = await central.health();\n    const catalog = await central.products();\n    const steel = await central.product('steel');\n\nآدرس واقعی API پس از استقرار از Cloudflare دریافت می‌شود؛ آن را حدس نزنید. در کد محصول از تنظیمات محیطی استفاده کنید، نه URL پراکنده و hard-code شده در چند فایل.\n\n## امنیت و محدودیت‌ها\n\n- فقط HTTPS مجاز است؛ HTTP فقط برای localhost توسعه.\n- درخواست‌ها GET، بدون cookie و بدون credential مرورگر هستند.\n- هیچ Secret، کلید والد، توکن دستگاه یا کلید مجوز تجاری در این کتابخانه قرار ندهید.\n- CORS جایگزین احراز هویت نیست.\n- این کتابخانه در نسخه فعلی برای کاتالوگ عمومی است؛ حساب، ورود و اعتبارسنجی اشتراک پس از تکمیل هویت مرکزی و API امن جداگانه اضافه می‌شوند.\n- کلاینت، خطاها را بدون افشای پاسخ داخلی یا جزئیات شبکه گزارش می‌کند.\n

## احراز هویت Firebase

- `firebase-auth.js` adapter برای Google Sign-In، Phone SMS با reCAPTCHA و پیوند دادن provider دوم به همان Firebase UID است.
- adapter توابع Firebase SDK را از برنامه میزبان دریافت می‌کند و Firebase app دوم نمی‌سازد.
- برنامه پس از ورود، Firebase ID token را با `central.authenticate(token)` به Worker می‌فرستد.
- برای پروفایل مرکزی از `central.me(token)` استفاده کنید.
- توکن را در URL، localStorage، فایل یا log ذخیره نکنید؛ مدیریت refresh token را به Firebase SDK بسپارید.
- جزئیات پیکربندی و نمونه اتصال در [FIREBASE-AUTH-SETUP.md](../FIREBASE-AUTH-SETUP.md) است.
