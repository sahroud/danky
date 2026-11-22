# فهرست رسمی محصولات SAHROUD

این فایل مرجع یکتای شناسه‌ محصولات برای SAHROUD Central است. هر محصول فقط یک `product_key` ثابت دارد؛ آدرس‌های قدیمی یا رابط‌های جایگزین نباید به‌عنوان محصول یا دیتابیس جدید ثبت شوند.

## محصولات شناسایی‌شده در مخازن فعلی

| نام محصول | product_key | مخزن و مسیر مرجع | دسته |
|---|---|---|---|
| SAHROUD FAMILY GUARD | `family-guard` | `sahroud/danky/family-guard/` | safety |
| SAHROUD STEEL | `steel` | `sahroud/steel/steel2/` | engineering |
| SAHROUD METREH | `metreh` | `sahroud/SAHROUD-METREH/` | construction |
| SAHROUD UTM | `utm` | `sahroud/utm/` | surveying |
| SAHROUD GPS | `gps` | `sahroud/utm/` (نسخه جایگزین در `sahroud/A/index.html`) | surveying |
| SAHROUD RTK | `rtk` | `sahroud/utm/gps-rtk/` (مسیر قدیمی در `sahroud/110/`) | surveying |
| SAHROUD EARTH | `earth` | `sahroud/utm/earth/` (فایل قدیمی در `sahroud/A/SahroudEarth.html`) | surveying |
| SAHROUD TOPOGRAPHY | `topography` | `sahroud/utm/topography/` | surveying |
| SAHROUD TASBIH | `tasbih` | `sahroud/A/tasbih/` | utility |
| SAHROUD RAKAT | `rakat` | `sahroud/A/rakat/` | utility |
| SAHROUD COUNTER | `counter` | `sahroud/A/counter/` | analytics |
| SAHROUD GAMES | `games` | `sahroud/A/games/` | games |
| SAHROUD WINDOWS DOCTOR | `windows-doctor` | `sahroud/A/windows-doctor/` | desktop-utility |

همه موارد این فهرست با وضعیت اولیه `development` در کاتالوگ مرکزی ثبت می‌شوند؛ ثبت در کاتالوگ به معنی فعال بودن سرویس ابری، آماده بودن برای انتشار عمومی یا تأیید کیفیت محصول نیست.

## جلوگیری از ثبت تکراری

- `sahroud/110/index.html` نسخه قدیمی مسیر RTK است؛ شناسه همان `rtk` باقی می‌ماند.
- `sahroud/A/SahroudEarth.html` نسخه قدیمی/جایگزین Earth است؛ شناسه همان `earth` است.
- صفحات GPS در `sahroud/A/index.html` و `sahroud/utm/index.html` عنوان و هدف مشترک دارند، اما SHA و اندازه فایل آن‌ها متفاوت است؛ آن‌ها را کپی بایت‌به‌بایت فرض نکنید. هر دو به شناسه `gps` تعلق دارند.
- فایل Earth در مخزن A و صفحه `utm/earth/index.html` نیز SHA متفاوت دارند؛ همان شناسه محصول `earth` را استفاده می‌کنند.
- نسخه‌های RTK در مخزن `110` و مسیر `utm/gps-rtk` نیز فایل‌های متفاوت‌اند؛ مسیر قدیمی را بدون برنامه مهاجرت حذف نکنید.
- `sahroud/utm/apps/` صفحه فهرست/درگاه مجموعه نقشه‌برداری است، نه محصول عملیاتی جداگانه.
- `sahroud/surveryRTK` در زمان بررسی فقط README داشت و به‌عنوان محصول مستقل ثبت نشده است.
- فایل `sahroud/danky/index.html` عنوان Pro Camera HD دارد و در این فهرست محصولات SAHROUD ثبت نمی‌شود.

## قواعد تغییر فهرست

1. برای محصول جدید ابتدا یک شناسه کوچک، ثابت و یکتا با حروف کوچک لاتین و خط تیره تعیین شود.
2. ابتدا ردیف محصول در یک migration جدید اضافه شود؛ migration منتشرشده هرگز بازنویسی نشود.
3. هر محصول فقط یک ردیف کاتالوگ دارد، حتی اگر چند لینک قدیمی یا چند رابط داشته باشد.
4. وضعیت کاتالوگ `development`، `beta`، `active` یا `retired` است و فقط با وضعیت واقعی انتشار تغییر می‌کند.
5. ثبت محصول در کاتالوگ، مجوز دسترسی یا اشتراک صادر نمی‌کند؛ احراز هویت و مجوز تجاری تا تکمیل لایه هویت مرکزی غیرفعال‌اند.

## منابع اصلی

- [مخزن مرکزی کدها](https://github.com/sahroud/danky)
- [مخزن STEEL](https://github.com/sahroud/steel)
- [مخزن METREH](https://github.com/sahroud/SAHROUD-METREH)
- [مخزن ابزارهای نقشه‌برداری](https://github.com/sahroud/utm)
- [مخزن مجموعه ابزارهای SAHROUD](https://github.com/sahroud/A)
