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
import android.hardware.Sensor
import android.hardware.SensorManager
import android.location.Location
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
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
    private var totalDistance = 0f
    private var routePoints = mutableListOf<String>()
    private var todaySteps = 0
    private var waterGlasses = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        waterGlasses = prefs.getInt("water_" + dayKey(), 0)
        totalDistance = prefs.getFloat("route_distance", 0f)
        routePoints = prefs.getString("route_points", "")!!.split("|").filter { it.isNotBlank() }.toMutableList()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(22, 24, 22, 28)
            setBackgroundColor(Color.rgb(245, 248, 252))
        }
        fun heading(text: String): TextView = TextView(this).apply {
            this.text = text
            textSize = 19f
            setTextColor(Color.rgb(20, 65, 105))
            setPadding(0, 22, 0, 8)
        }
        fun body(text: String): TextView = TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(Color.DKGRAY)
            setPadding(0, 6, 0, 10)
        }
        fun action(text: String, click: () -> Unit) = Button(this).apply {
            this.text = text
            setOnClickListener { click() }
        }

        root.addView(TextView(this).apply {
            text = "SAHROUD FAMILY GUARD & HEALTH"
            textSize = 21f
            setTextColor(Color.rgb(16, 76, 120))
            gravity = Gravity.CENTER
            setPadding(0, 8, 0, 14)
        })
        root.addView(body("موقعیت، مسیر، گام‌شمار و پایش عادت‌های سلامت در یک برنامه"))
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
        root.addView(heading("۴) گزارش امروز"))
        root.addView(body("گام‌ها، مسافت GPS و آب مصرفی به‌صورت محلی روی همین گوشی ذخیره می‌شوند. این نسخه هنوز به سرور مرکزی یا گوشی اعضای خانواده ارسال نمی‌کند."))
        root.addView(body("هشدار: این برنامه ابزار تشخیص یا درمان پزشکی نیست. فشارخون و ضربان قلب را باید با دستگاه معتبر اندازه‌گیری و سپس دستی ثبت کنید."))
        setContentView(ScrollView(this).apply { addView(root) })
        refreshHealth()
        refreshStepsText()
        restoreRouteDisplay()
    }

    private val locationReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == LocationTrackingService.ACTION_LOCATION_UPDATE) restoreRouteDisplay()
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

    private fun dayKey(): String = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())

    private fun startTracking() {
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
        prefs.edit().putFloat("route_distance", 0f).putString("route_points", "").apply()
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
        refreshStepsText()
    }

    override fun onPause() {
        try { unregisterReceiver(locationReceiver) } catch (_: Exception) {}
        super.onPause()
    }

    override fun onDestroy() {
        sensorManager.unregisterListener(this)
        super.onDestroy()
    }
}
