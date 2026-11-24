# راه‌اندازی ورود مرکزی SAHROUD با Google و پیامک

## تصمیم فنی

هر دو روش ورود از یک پروژه Firebase Authentication استفاده می‌کنند:

- Google Sign-In برای ورود با حساب Google
- Phone Authentication برای دریافت و تأیید کد پیامکی
- Firebase UID شناسه پایدار هویت خارجی است؛ Worker آن را به یک `principal` و حساب شخصی مرکزی متصل می‌کند.
- اگر کاربر هر دو روش را می‌خواهد، باید روش دوم را از داخل حساب واردشده با قابلیت **Link provider** به همان Firebase UID متصل کند. ورود جداگانه با دو روش ممکن است دو Firebase UID و دو حساب مرکزی مستقل بسازد؛ ادغام خودکار بر اساس ایمیل انجام نمی‌شود.

## هزینه و محدودیت

- ورود Google در Firebase Authentication در طرح Spark رایگان است.
- Phone Authentication پیامک رایگان در Spark ندارد؛ برای ارسال SMS باید پروژه به طرح Blaze و Cloud Billing متصل شود و هر SMS هزینه دارد.
- پیش از فعال‌کردن Billing یا ارسال پیامک واقعی، هزینه کشور مقصد و بودجه/سقف مصرف را بررسی کنید. هیچ ارسال پیامکی از طرف این مخزن به‌صورت خودکار فعال نشده است.
- Firebase برای Phone Auth از reCAPTCHA و محدودیت‌های ضدسوءاستفاده استفاده می‌کند. کشورها و اپراتورها از نظر تحویل پیامک یکسان نیستند.

منابع رسمی:
- https://firebase.google.com/docs/auth
- https://firebase.google.com/docs/auth/web/google-signin
- https://firebase.google.com/docs/auth/web/phone-auth
- https://firebase.google.com/docs/auth/limits
- https://firebase.google.com/docs/auth/faq-and-troubleshooting
- https://firebase.google.com/pricing/

## ۱. ایجاد پروژه Firebase

1. به https://console.firebase.google.com بروید و یک پروژه برای SAHROUD Central بسازید.
2. در Project settings یک Web App اضافه کنید.
3. مقدارهای `projectId`، `apiKey`، `authDomain` و `appId` را نگه دارید. Web API Key در برنامه وب قابل مشاهده است و **رمز محرمانه نیست**؛ آن را در Google Cloud به APIهای لازم و دامنه‌های خود محدود کنید.
4. از بخش Authentication → Sign-in method، روش Google را فعال کنید.
5. Phone را فقط پس از بررسی هزینه و تأیید آگاهانه Billing فعال کنید.
6. در Authentication → Settings → Authorized domains، دامنه‌های واقعی برنامه‌های SAHROUD را اضافه کنید.
7. در SMS region policy فقط کشورهای موردنیاز را مجاز کنید. برای آزمایش اولیه از شماره‌های آزمایشی Firebase استفاده کنید و قبل از ارسال واقعی، تحویل پیامک به اپراتورهای مقصد را بررسی کنید.

## ۲. تنظیم Worker مرکزی

در Cloudflare Dashboard → Workers & Pages → `sahroud-central-api` → Settings → Variables and Secrets:

- متغیر متنی `FIREBASE_PROJECT_ID` را با مقدار دقیق `projectId` پروژه Firebase اضافه کنید.
- این مقدار شناسه عمومی پروژه است، نه Secret.
- هیچ Service Account JSON، Private Key، Cloudflare Token یا Firebase Admin credential در Git، مرورگر یا APK قرار ندهید.

در حال حاضر این متغیر در محیط Worker تنظیم نشده است؛ بنابراین endpoint احراز هویت با `auth_not_configured` پاسخ می‌دهد و ورود هنوز فعال نیست. افزودن Project ID و انتشار نسخه جدید Worker مرحله فعال‌سازی پس از تنظیم Firebase است.

## ۳. APIهای پیاده‌سازی‌شده

- `POST /v1/auth/session`: دریافت Firebase ID token در هدر Bearer، اعتبارسنجی امضا و claimها، سپس ساخت/بازیابی principal و حساب شخصی مرکزی.
- `GET /v1/me`: اعتبارسنجی مجدد Firebase ID token و بازگرداندن شناسه و نقش حساب مرکزی.
- فقط providerهای `google.com` و `phone` پذیرفته می‌شوند.
- توکن با کلیدهای عمومی رسمی Firebase بررسی می‌شود؛ audience و issuer دقیقاً به Project ID محدودند.
- رمز، کد پیامک، شماره تلفن و Firebase ID token در D1 ذخیره نمی‌شوند.
- برای درخواست‌های بعدی، Firebase ID token در هدر Authorization فرستاده می‌شود؛ کلاینت مرکزی آن را در localStorage یا cookie اختصاصی خود ذخیره نمی‌کند.
- API هنوز مجوز محصول، اشتراک و دسترسی endpointهای محصول را صادر نمی‌کند؛ این‌ها مرحله بعدی‌اند.

## ۴. نمونه اتصال وب

برنامه وب باید Firebase SDK را در build خودش نصب و پیکربندی کند. نمونه زیر APIهای لازم را نشان می‌دهد؛ تنظیمات واقعی را از Firebase Console بگیرید:

```js
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  linkWithPopup,
  linkWithPhoneNumber
} from "firebase/auth";

import { createSahroudCentralClient } from "./sahroud-central.js";
import { createSahroudFirebaseAuth } from "./firebase-auth.js";

const firebaseApp = initializeApp({
  apiKey: "FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "FIREBASE_APP_ID"
});
const firebase = getAuth(firebaseApp);
const central = createSahroudCentralClient({
  apiBase: "https://sahroud-central-api.sahroud.workers.dev"
});

const sahroudAuth = createSahroudFirebaseAuth({
  auth: firebase,
  GoogleAuthProvider,
  signInWithPopup,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  linkWithPopup,
  linkWithPhoneNumber,
  centralClient: central
});

// Google:
const centralUser = await sahroudAuth.signInWithGoogle();

// Phone: صفحه باید عنصر <div id="sahroud-recaptcha"></div> داشته باشد.
await sahroudAuth.sendPhoneCode("+989120000000");
const phoneUser = await sahroudAuth.verifyPhoneCode("123456");

// اگر کاربر با Google وارد شده و می‌خواهد تلفن را به همان حساب وصل کند:
// await sahroudAuth.sendPhoneCodeToLinkCurrentUser("+989120000000");
// await sahroudAuth.verifyPhoneCode("123456");

// برای اطلاعات حساب مرکزی، توکن تازه را از Firebase بگیرید و به central.me بدهید:
const idToken = await firebase.currentUser.getIdToken();
const profile = await central.me(idToken);
```

این نمونه کد اتصال است، نه صفحه ورود آماده یا برنامه منتشرشده. UI باید خطاهای Firebase، لغو popup، reCAPTCHA، محدودیت پیامک و حالت بازیابی حساب را به کاربر نشان دهد.

## ۵. آزمون و انتشار

از پوشه `platform`:

```cmd
npm install
npm test
python test/schema.test.py
```

پس از ساخت پروژه Firebase و افزودن `FIREBASE_PROJECT_ID` در Cloudflare، Worker را با همان نسخه کد مستقر کنید و ابتدا ورود Google را آزمایش کنید. Phone Auth فقط پس از تأیید هزینه و فعال‌سازی Billing آزمایش شود.

## ۶. وضعیت داده‌ها

- فقط Firebase UID و شناسه‌های مرکزی در D1 مرکزی ثبت می‌شوند.
- شماره تلفن، ایمیل، کد پیامک، موقعیت مکانی و داده سلامت در D1 مرکزی ذخیره نمی‌شوند.
- دیتابیس مستقل `sahroud-family-guard` و داده‌های GPS آن در این پیاده‌سازی تغییر نمی‌کنند.
- اگر دو حساب Firebase از قبل جداگانه ساخته شده باشند، به دلیل خطر تصاحب حساب، ادغام خودکار بر اساس ایمیل انجام نمی‌شود؛ باید فرایند بازیابی و پیوند امن جداگانه طراحی شود.
