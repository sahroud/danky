package ir.sahroud.familyguard

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.os.Build
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.hardware.Sensor
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Calendar
import java.util.Locale

class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("sahroud_health", Context.MODE_PRIVATE) }
    private lateinit var sensorManager: SensorManager
    private var stepSensor: Sensor? = null
    private lateinit var statusText: TextView
    private lateinit var locationText: TextView
    private lateinit var stepsText: TextView
    private lateinit var distanceText: TextView
    private lateinit var healthText: TextView
    private lateinit var waterText: TextView
    private lateinit var reportText: TextView
    private lateinit var familyStatusText: TextView
    private var totalDistance = 0f
    private var routePoints = mutableListOf<String>()
    private var todaySteps = 0
    private var waterGlasses = 0
    private var pendingTrackingAfterLocationSettings = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        waterGlasses = prefs.getInt("water_" + dayKey(), 0)
        totalDistance = prefs.getFloat("route_distance", 0f)
        routePoints = prefs.getString("route_points", "")!!.split("|").filter { it.isNotBlank() }.toMutableList()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 18, 16, 28)
            setBackgroundColor(Color.rgb(239, 245, 249))
        }
        fun heading(text: String): TextView = TextView(this).apply {
            this.text = text
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(17, 66, 94))
            setPadding(15, 17, 15, 13)
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = 22f
                setStroke(1, Color.rgb(222, 233, 240))
            }
        }
        fun body(text: String): TextView = TextView(this).apply {
            this.text = text
            textSize = 14f
            setTextColor(Color.rgb(48, 69, 84))
            setPadding(12, 9, 12, 11)
            setLineSpacing(3f, 1f)
        }
        fun action(text: String, click: () -> Unit) = Button(this).apply {
            this.text = text
            isAllCaps = false
            textSize = 14f
            minHeight = 52
            setTextColor(Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(Color.rgb(20, 105, 133))
            setPadding(14, 8, 14, 8)
            setOnClickListener { click() }
        }

        root.addView(TextView(this).apply {
            text = "SAHROUD FAMILY GUARD & HEALTH"
            textSize = 20f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(16, 24, 16, 10)
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.rgb(16, 54, 83), Color.rgb(18, 119, 132))
            ).apply { cornerRadius = 26f }
        })
        root.addView(body("موقعیت و مسیر با رضایت صاحب گوشی | گام‌شمار و اطلاعات سلامت فقط روی همین گوشی"))
        root.addView(action("بررسی به‌روزرسانی برنامه") { checkForUpdates(true) })
        root.addView(heading("۱) موقعیت و ثبت مسیر"))
        statusText = body("ثبت موقعیت خاموش است. با آگاهی و اجازه خودتان شروع کنید.")
        locationText = body("هنوز موقعیتی ثبت نشده است.")
        distanceText = body("مسافت این نوبت: ۰ متر | نقاط مسیر: ۰")
        root.addView(statusText)
        root.addView(locationText)
        root.addView(distanceText)
        root.addView(action("شروع ثبت مسیر در پس‌زمینه") { startTracking() })
        root.addView(action("توقف ثبت موقعیت") { stopTracking() })
        root.addView(body("هنگام ثبت پس‌زمینه، اعلان دائمی و قابل مشاهده نمایش داده می‌شود؛ هر زمان می‌توانید آن را متوقف کنید."))
        root.addView(action("نمایش آخرین موقعیت روی نقشه") { openLastLocation() })
        root.addView(action("پاک کردن مسیر و مسافت این نوبت") { clearRoute() })

        root.addView(heading("اتصال به خانواده و اشتراک‌گذاری موقعیت"))
        root.addView(body("اتصال فقط با کد دعوت والد و تأیید آگاهانه صاحب همین گوشی انجام می‌شود. پس از اتصال، ارسال موقعیت فقط هنگام فعال بودن ثبت مسیر و نمایش اعلان انجام می‌شود."))
        root.addView(action("اتصال این گوشی به خانواده با کد دعوت") { pairDevice() })
        root.addView(action("قطع اشتراک‌گذاری و خروج از خانواده") { stopFamilySharing() })
        familyStatusText = body("")
        root.addView(familyStatusText)
        refreshFamilyStatus()

        root.addView(heading("۲) گام‌شمار و فعالیت روزانه"))
        stepsText = body("در حال آماده‌سازی حسگر گام‌شمار…")
        root.addView(stepsText)
        root.addView(action("فعال‌سازی گام‌شمار پس‌زمینه") { startStepCounter() })
        root.addView(action("توقف گام‌شمار پس‌زمینه") { stopStepCounter() })
        root.addView(body("برای شمارش در پس‌زمینه، سرویس آشکار با اعلان دائمی فعال می‌شود. برای توقف از اعلان یا دکمهٔ بالا استفاده کنید."))
        root.addView(body("هدف پیش‌فرض روزانه: ۶۰۰۰ گام. شمارش به حسگر گوشی وابسته است و برای دقت بهتر گوشی را همراه خود داشته باشید."))
        root.addView(action("تازه‌سازی وضعیت گام‌شمار") { refreshStepsText() })

        root.addView(heading("۳) ثبت اطلاعات سلامت"))
        healthText = body("")
        waterText = body("")
        root.addView(healthText)
        root.addView(action("ثبت وزن، قد، فشارخون و ضربان قلب") { editHealth() })
        root.addView(waterText)
        root.addView(action("ثبت یک لیوان آب") {
            waterGlasses++
            prefs.edit().putInt("water_" + dayKey(), waterGlasses).apply()
            refreshHealth()
        })
        root.addView(action("بازنشانی شمارش آب امروز") {
            waterGlasses = 0
            prefs.edit().putInt("water_" + dayKey(), 0).apply()
            refreshHealth()
        })
        root.addView(heading("۴) گزارش روزانه و هفتگی"))
        reportText = body("گزارش فعالیت هنوز آماده نیست.")
        root.addView(reportText)
        root.addView(action("به‌روزرسانی گزارش هفتگی") { refreshWeeklyReport() })
        root.addView(body("گام‌شمار و اطلاعات سلامت فقط روی همین گوشی ذخیره می‌شوند و برای والد ارسال نمی‌شوند. موقعیت GPS فقط پس از اتصال با دعوت و رضایت صاحب گوشی، و فقط هنگام روشن بودن ثبت مسیر، به پنل خانواده ارسال می‌شود."))
        root.addView(body("هشدار: این برنامه ابزار تشخیص یا درمان پزشکی نیست. فشارخون و ضربان قلب را باید با دستگاه معتبر اندازه‌گیری و سپس دستی ثبت کنید."))
        setContentView(ScrollView(this).apply { addView(root) })
        refreshHealth()
        refreshStepsText()
        restoreRouteDisplay()
        checkForUpdates(false)
    }


    // Offers official releases. Installing over the existing package preserves
    // local data; the user confirms the release page and Android installer.
    private fun checkForUpdates(showUpToDate: Boolean) {
        Thread {
            try {
                val connection = java.net.URL("https://api.github.com/repos/sahroud/danky/releases/latest")
                    .openConnection() as java.net.HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.setRequestProperty("Accept", "application/vnd.github+json")
                connection.setRequestProperty("User-Agent", "SAHROUD-FAMILY-GUARD")
                val code = connection.responseCode
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                val json = org.json.JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                connection.disconnect()
                val tag = json.optString("tag_name", "")
                val releaseUrl = json.optString("html_url", "https://github.com/sahroud/danky/releases")
                val latest = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(tag)?.groupValues?.drop(1)?.map { it.toInt() }
                    ?: return@Thread
                @Suppress("DEPRECATION")
                val currentName = packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
                val current = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(currentName)?.groupValues?.drop(1)?.map { it.toInt() }
                    ?: listOf(0, 0, 0)
                val newer = (0..2).firstNotNullOfOrNull { i ->
                    when {
                        latest[i] > current.getOrElse(i) { 0 } -> true
                        latest[i] < current.getOrElse(i) { 0 } -> false
                        else -> null
                    }
                } ?: false
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    if (newer) {
                        AlertDialog.Builder(this)
                            .setTitle("نسخه جدید برنامه آماده است")
                            .setMessage("نسخه $tag منتشر شده است. صفحه دریافت رسمی باز شود؟\\n\\nبرای حفظ اطلاعات، برنامه قبلی را حذف نکنید؛ نسخه جدید را روی همان برنامه نصب کنید.")
                            .setNegativeButton("بعداً", null)
                            .setPositiveButton("مشاهده و دریافت") { _, _ ->
                                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl))) }
                                catch (_: Exception) { Toast.makeText(this, "بازکردن صفحه دریافت ممکن نشد.", Toast.LENGTH_LONG).show() }
                            }.show()
                    } else if (showUpToDate) {
                        Toast.makeText(this, "برنامه به‌روز است.", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (_: Exception) {
                if (showUpToDate) runOnUiThread {
                    Toast.makeText(this, "بررسی نسخه ممکن نشد؛ اتصال اینترنت را بررسی کنید.", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private val locationReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == LocationTrackingService.ACTION_LOCATION_UPDATE) {
                restoreRouteDisplay()
                refreshFamilyStatus()
            }
            if (intent?.action == StepCounterService.ACTION_STEPS_UPDATE) refreshStepsText()
        }
    }

    private fun restoreRouteDisplay() {
        val lat = prefs.getString("last_lat", null)
        val lon = prefs.getString("last_lon", null)
        if (lat != null && lon != null) {
            locationText.text = "آخرین موقعیت: عرض $lat | طول $lon\nزمان ثبت: ${prefs.getString("last_location_time", "نامشخص")}"
        }
        totalDistance = prefs.getFloat("route_distance", totalDistance)
        routePoints = prefs.getString("route_points", "").orEmpty().split("|").filter { it.isNotBlank() }.toMutableList()
        distanceText.text = "مسافت ثبت‌شده: ${formatDistance(totalDistance)} | نقاط مسیر: ${routePoints.size}"
        statusText.text = if (prefs.getBoolean("tracking_active", false)) "ثبت مسیر پس‌زمینه فعال است؛ اعلان برنامه باید قابل مشاهده باشد." else "ثبت موقعیت متوقف است."
    }


    private fun pairDevice() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 8, 28, 0)
        }
        val apiInput = EditText(this).apply {
            hint = "نشانی کامل API (https://...workers.dev)"
            setSingleLine(true)
            setText(prefs.getString("family_api_url", ""))
        }
        val codeInput = EditText(this).apply { hint = "کد دعوت والد"; setSingleLine(true) }
        val labelInput = EditText(this).apply { hint = "نام این گوشی/عضو"; setSingleLine(true) }
        val consent = android.widget.CheckBox(this).apply {
            text = "آگاه هستم که موقعیت این گوشی هنگام فعال بودن ثبت مسیر برای مدیر خانواده ارسال می‌شود و هر زمان می‌توانم اشتراک‌گذاری را متوقف کنم."
        }
        box.addView(apiInput); box.addView(codeInput); box.addView(labelInput); box.addView(consent)
        AlertDialog.Builder(this)
            .setTitle("اتصال با رضایت صاحب گوشی")
            .setView(box)
            .setNegativeButton("انصراف", null)
            .setPositiveButton("تأیید و اتصال") { _, _ ->
                val api = apiInput.text.toString().trim().trimEnd('/')
                val code = codeInput.text.toString().trim()
                val label = labelInput.text.toString().trim()
                if (!api.startsWith("https://") || code.isBlank() || label.isBlank() || !consent.isChecked) {
                    Toast.makeText(this, "نشانی HTTPS، کد، نام دستگاه و تأیید رضایت الزامی است.", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                prefs.edit().putString("family_api_url", api).apply()
                Thread {
                    try {
                        val connection = java.net.URL("$api/v1/devices/pair").openConnection() as java.net.HttpURLConnection
                        connection.requestMethod = "POST"
                        connection.connectTimeout = 15000
                        connection.readTimeout = 15000
                        connection.doOutput = true
                        connection.setRequestProperty("Content-Type", "application/json")
                        val payload = org.json.JSONObject()
                            .put("invite_code", code)
                            .put("device_label", label)
                            .put("consent", true).toString()
                        connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
                        val response = stream.bufferedReader().use { it.readText() }
                        if (connection.responseCode !in 200..299) throw IllegalStateException(response)
                        val data = org.json.JSONObject(response)
                        DeviceCredentials.get(this).edit()
                            .putString("device_token", data.getString("device_token"))
                            .putString("device_id", data.getString("device_id"))
                            .putString("device_label", label)
                            .apply()
                        runOnUiThread {
                            Toast.makeText(this, "این گوشی با رضایت شما به خانواده متصل شد.", Toast.LENGTH_LONG).show()
                            refreshFamilyStatus()
                            restoreRouteDisplay()
                        }
                        connection.disconnect()
                    } catch (e: Exception) {
                        runOnUiThread { Toast.makeText(this, "اتصال ناموفق: ${e.message ?: "خطای شبکه"}", Toast.LENGTH_LONG).show() }
                    }
                }.start()
            }.show()
    }

    private fun refreshFamilyStatus() {
        if (!::familyStatusText.isInitialized) return
        val secure = DeviceCredentials.get(this)
        val connected = !secure.getString("device_token", null).isNullOrBlank()
        val uploadError = prefs.getString("family_upload_error", null)
        val lastUpload = prefs.getString("family_last_upload", null)
        val tracking = prefs.getBoolean("tracking_active", false)
        familyStatusText.text = if (connected) {
            buildString {
                append("وضعیت اتصال: متصل به خانواده")
                append(if (tracking) "\\nثبت مسیر روشن است؛ ارسال موقعیت فعال است." else "\\nثبت مسیر خاموش است؛ موقعیتی ارسال نمی‌شود.")
                if (!lastUpload.isNullOrBlank()) append("\\nآخرین ارسال موفق: $lastUpload")
                if (!uploadError.isNullOrBlank()) append("\\nآخرین خطای ارسال: $uploadError")
            }
        } else {
            "وضعیت اتصال: متصل نیست"
        }
    }

    private fun stopFamilySharing() {
        // Stop local collection immediately, even if the network is unavailable.
        stopTracking()
        val secure = DeviceCredentials.get(this)
        val token = secure.getString("device_token", null)
        val api = prefs.getString("family_api_url", null)
        if (token.isNullOrBlank() || api.isNullOrBlank()) {
            secure.edit().clear().apply()
            refreshFamilyStatus()
            Toast.makeText(this, "اشتراک‌گذاری محلی متوقف شد؛ اتصال فعالی برای لغو در سرور پیدا نشد.", Toast.LENGTH_SHORT).show()
            return
        }
        Thread {
            try {
                val connection = java.net.URL("$api/v1/devices/sharing/stop").openConnection() as java.net.HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write("{}".toByteArray()) }
                if (connection.responseCode !in 200..299) throw IllegalStateException("HTTP ${connection.responseCode}")
                connection.disconnect()
                secure.edit().clear().apply()
                runOnUiThread {
                    refreshFamilyStatus()
                    Toast.makeText(this, "اشتراک‌گذاری در سرور متوقف و کلید این گوشی پاک شد.", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "توقف در سرور انجام نشد: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    private fun dayKey(): String = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())

    private fun isDeviceLocationEnabled(): Boolean {
        val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return try {
            if (Build.VERSION.SDK_INT >= 28) manager.isLocationEnabled
            else manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
            false
        }
    }

    private fun requestDeviceLocationEnabled() {
        AlertDialog.Builder(this)
            .setTitle("روشن کردن مکان گوشی")
            .setMessage("برای ثبت و نمایش مسیر، ابتدا مکان (Location/GPS) گوشی را روشن کنید. با انتخاب «رفتن به تنظیمات»، صفحه تنظیم مکان باز می‌شود. پس از روشن کردن مکان و بازگشت به برنامه، وضعیت دوباره بررسی خواهد شد.")
            .setNegativeButton("فعلاً نه") { _, _ ->
                pendingTrackingAfterLocationSettings = false
                statusText.text = "مکان گوشی خاموش است؛ ثبت مسیر شروع نشد."
            }
            .setPositiveButton("رفتن به تنظیمات") { _, _ ->
                pendingTrackingAfterLocationSettings = true
                try {
                    startActivity(Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                } catch (e: Exception) {
                    pendingTrackingAfterLocationSettings = false
                    statusText.text = "باز کردن تنظیمات مکان ناموفق بود: ${e.localizedMessage ?: "خطای نامشخص"}"
                }
            }
            .show()
    }

    private fun startTracking() {
        // Require system Location to be enabled before asking for permissions or starting the service.
        if (!isDeviceLocationEnabled()) {
            requestDeviceLocationEnabled()
            return
        }
        pendingTrackingAfterLocationSettings = false
        // Keep foreground location sharing visibly disclosed on Android 13+.
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 44)
            return
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 41)
            return
        }
        try {
            val intent = Intent(this, LocationTrackingService::class.java).setAction(LocationTrackingService.ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
            statusText.text = "درخواست شروع ثبت مسیر پس‌زمینه ارسال شد."
        } catch (e: Exception) {
            statusText.text = "شروع سرویس ناموفق بود: ${e.localizedMessage ?: "خطای نامشخص"}"
        }
    }

    private fun stopTracking() {
        try { startService(Intent(this, LocationTrackingService::class.java).setAction(LocationTrackingService.ACTION_STOP)) } catch (_: Exception) {}
        prefs.edit().putBoolean("tracking_active", false).apply()
        statusText.text = "درخواست توقف ثبت مسیر ارسال شد."
    }

    private fun formatDistance(m: Float): String =
        if (m >= 1000f) "${"%.2f".format(Locale.US, m / 1000f)} کیلومتر" else "${m.toInt()} متر"

    private fun openLastLocation() {
        val lat = prefs.getString("last_lat", null)
        val lon = prefs.getString("last_lon", null)
        if (lat == null || lon == null) {
            Toast.makeText(this, "هنوز موقعیتی ثبت نشده است.", Toast.LENGTH_SHORT).show()
            return
        }
        val url = "https://www.openstreetmap.org/?mlat=$lat&mlon=$lon#map=17/$lat/$lon"
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun clearRoute() {
        stopTracking()
        totalDistance = 0f
        routePoints.clear()
        prefs.edit().putFloat("route_distance", 0f).putString("route_points", "")
            .remove("last_lat").remove("last_lon").remove("last_location_time").apply()
        distanceText.text = "مسافت این نوبت: ۰ متر | نقاط مسیر: ۰"
        locationText.text = "مسیر پاک شد."
    }

    private fun startStepCounter() {
        if (stepSensor == null) {
            Toast.makeText(this, "حسگر سخت‌افزاری گام‌شمار در این گوشی موجود نیست.", Toast.LENGTH_LONG).show()
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 43)
            return
        }
        if (Build.VERSION.SDK_INT >= 29 && checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACTIVITY_RECOGNITION), 42)
            return
        }
        try {
            val intent = Intent(this, StepCounterService::class.java).setAction(StepCounterService.ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
            stepsText.text = "درخواست فعال‌سازی گام‌شمار پس‌زمینه ارسال شد."
        } catch (e: Exception) {
            stepsText.text = "شروع گام‌شمار ناموفق بود: ${e.localizedMessage ?: "خطای نامشخص"}"
        }
    }

    private fun stopStepCounter() {
        try { startService(Intent(this, StepCounterService::class.java).setAction(StepCounterService.ACTION_STOP)) } catch (_: Exception) {}
        prefs.edit().putBoolean("step_service_active", false).apply()
        refreshStepsText()
    }

    private fun refreshStepsText() {
        if (stepSensor == null) {
            stepsText.text = "این گوشی حسگر سخت‌افزاری گام‌شمار ندارد؛ شمارش خودکار در دسترس نیست."
            return
        }
        todaySteps = prefs.getInt("today_steps", todaySteps)
        val progress = (todaySteps * 100 / 6000).coerceAtMost(100)
        val state = if (prefs.getBoolean("step_service_active", false)) "گام‌شمار پس‌زمینه: فعال" else "گام‌شمار پس‌زمینه: متوقف"
        stepsText.text = "گام امروز: $todaySteps\nپیشرفت هدف ۶۰۰۰ گام: $progress٪\nمسافت تقریبی بر اساس گام: ${formatDistance(todaySteps * 0.75f)}\n$state"
        refreshWeeklyReport()
    }

    private fun refreshWeeklyReport() {
        if (!::reportText.isInitialized) return
        val cal = Calendar.getInstance()
        val lines = mutableListOf<String>()
        var total = 0
        for (offset in 0..6) {
            val day = cal.clone() as Calendar
            day.add(Calendar.DAY_OF_YEAR, -offset)
            val key = SimpleDateFormat("yyyyMMdd", Locale.US).format(day.time)
            val value = if (key == dayKey()) prefs.getInt("today_steps", 0)
                        else prefs.getInt("steps_$key", -1)
            if (value >= 0) {
                total += value
                val label = SimpleDateFormat("yyyy/MM/dd", Locale.US).format(day.time)
                lines.add("$label : $value گام")
            } else {
                val label = SimpleDateFormat("yyyy/MM/dd", Locale.US).format(day.time)
                lines.add("$label : داده‌ای ثبت نشده")
            }
        }
        reportText.text = "مجموع گام‌های ثبت‌شده در ۷ روز: $total\n" + lines.joinToString("\n")
    }

    private fun refreshHealth() {
        val weight = prefs.getString("weight", null)
        val height = prefs.getString("height", null)
        val bmi = if (weight != null && height != null) {
            val h = height.toFloatOrNull()?.div(100f) ?: 0f
            val w = weight.toFloatOrNull() ?: 0f
            if (h > 0f && w > 0f) " | BMI: ${"%.1f".format(Locale.US, w / (h * h))}" else ""
        } else ""
        val bp = prefs.getString("bp", "ثبت نشده")
        val hr = prefs.getString("hr", "ثبت نشده")
        healthText.text = "وزن: ${weight ?: "ثبت نشده"} کیلوگرم | قد: ${height ?: "ثبت نشده"} سانتی‌متر$bmi\nفشارخون: $bp | ضربان قلب: $hr"
        waterText.text = "آب امروز: $waterGlasses لیوان"
    }

    private fun editHealth() {
        val fields = listOf(
            "وزن به کیلوگرم" to "weight",
            "قد به سانتی‌متر" to "height",
            "فشارخون (مثلاً ۱۲۰/۸۰)" to "bp",
            "ضربان قلب در دقیقه" to "hr"
        )
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(30, 8, 30, 0)
        }
        val inputs = fields.map { (label, key) ->
            val edit = EditText(this).apply {
                hint = label
                setSingleLine(true)
                setText(prefs.getString(key, ""))
            }
            container.addView(edit)
            key to edit
        }
        AlertDialog.Builder(this)
            .setTitle("ثبت دستی اطلاعات سلامت")
            .setView(container)
            .setNegativeButton("انصراف", null)
            .setPositiveButton("ذخیره") { _, _ ->
                val editor = prefs.edit()
                inputs.forEach { (key, edit) ->
                    val value = edit.text.toString().trim()
                    if (value.isNotEmpty()) editor.putString(key, value)
                }
                editor.apply()
                refreshHealth()
            }.show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 44 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startTracking()
        } else if (requestCode == 44) {
            statusText.text = "برای نمایش اعلان دائمی، مجوز اعلان لازم است؛ ثبت مسیر شروع نشد."
        }
        if (requestCode == 41 && grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
            startTracking()
        } else if (requestCode == 41) {
            statusText.text = "مجوز مکان داده نشد؛ ثبت مسیر شروع نشد."
        }
        if ((requestCode == 42 || requestCode == 43) && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startStepCounter()
        } else if (requestCode == 42 || requestCode == 43) {
            Toast.makeText(this, "مجوز لازم داده نشد؛ گام‌شمار پس‌زمینه شروع نشد.", Toast.LENGTH_LONG).show()
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            val filter = IntentFilter(LocationTrackingService.ACTION_LOCATION_UPDATE).apply { addAction(StepCounterService.ACTION_STEPS_UPDATE) }
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(locationReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else registerReceiver(locationReceiver, filter)
        } catch (_: Exception) {}
        restoreRouteDisplay()
        refreshFamilyStatus()
        refreshStepsText()
        if (pendingTrackingAfterLocationSettings) {
            if (isDeviceLocationEnabled()) {
                pendingTrackingAfterLocationSettings = false
                startTracking()
            } else {
                statusText.text = "مکان گوشی هنوز خاموش است؛ برای شروع ثبت مسیر، مکان را روشن کنید."
            }
        }
    }

    override fun onPause() {
        try { unregisterReceiver(locationReceiver) } catch (_: Exception) {}
        super.onPause()
    }

}
