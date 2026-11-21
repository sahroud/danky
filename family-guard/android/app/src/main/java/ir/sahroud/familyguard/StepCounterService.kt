package ir.sahroud.familyguard

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import androidx.core.app.NotificationCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class StepCounterService : Service(), SensorEventListener {
    companion object {
        const val ACTION_START = "ir.sahroud.familyguard.steps.START"
        const val ACTION_STOP = "ir.sahroud.familyguard.steps.STOP"
        const val ACTION_STEPS_UPDATE = "ir.sahroud.familyguard.steps.UPDATE"
        private const val CHANNEL_ID = "visible_step_counter"
        private const val NOTIFICATION_ID = 7102
    }
    private val prefs by lazy { getSharedPreferences("sahroud_health", Context.MODE_PRIVATE) }
    private lateinit var sensorManager: SensorManager
    private var stepSensor: Sensor? = null

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopCounter(); return START_NOT_STICKY }
            ACTION_START, null -> startCounter()
        }
        return START_NOT_STICKY
    }

    private fun startCounter() {
        if (Build.VERSION.SDK_INT >= 29 && checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf()
            return
        }
        val sensor = stepSensor
        if (sensor == null) { stopSelf(); return }
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        else startForeground(NOTIFICATION_ID, notification)
        if (!sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)) {
            prefs.edit().putBoolean("step_service_active", false).apply()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        prefs.edit().putBoolean("step_service_active", true).apply()
        sendUpdate()
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event?.sensor?.type != Sensor.TYPE_STEP_COUNTER || event.values.isEmpty()) return
        val raw = event.values[0]
        val today = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
        val savedDay = prefs.getString("step_day", "")
        val previousRaw = prefs.getFloat("step_last_sensor", -1f)
        val bootCount = try {
            Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT, -1)
        } catch (_: Exception) { -1 }
        val previousBootCount = prefs.getInt("step_boot_count", -1)
        var count = prefs.getInt("today_steps", 0)
        val newDay = savedDay != today
        val rebooted = bootCount >= 0 && previousBootCount >= 0 && bootCount != previousBootCount
        if (newDay) count = 0
        // Never subtract counters across a reboot. Keep the day's saved total and establish a new baseline.
        else if (!rebooted && previousRaw >= 0f && raw >= previousRaw) {
            count += (raw - previousRaw).toInt().coerceAtLeast(0)
        }
        prefs.edit().putString("step_day", today).putFloat("step_last_sensor", raw)
            .putInt("step_boot_count", bootCount).putInt("today_steps", count)
            .putInt("steps_$today", count)
            .putBoolean("step_service_active", true).apply()
        sendUpdate()
        updateNotification(count)
    }

    private fun sendUpdate() {
        sendBroadcast(Intent(ACTION_STEPS_UPDATE).setPackage(packageName))
    }

    private fun stopCounter() {
        sensorManager.unregisterListener(this)
        prefs.edit().putBoolean("step_service_active", false).apply()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        sendUpdate()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "گام‌شمار پس‌زمینه", NotificationManager.IMPORTANCE_LOW)
            channel.description = "اعلان آشکار هنگام شمارش گام‌ها"
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(count: Int? = null): Notification {
        val stop = Intent(this, StepCounterService::class.java).setAction(ACTION_STOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        val stopPending = PendingIntent.getService(this, 7202, stop, flags)
        val openPending = PendingIntent.getActivity(this, 7203, Intent(this, MainActivity::class.java), flags)
        val text = if (count == null) "گام‌شمار پس‌زمینه فعال است." else "گام‌های امروز: $count | شمارش فعال است."
        return NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("SAHROUD FAMILY GUARD").setContentText(text).setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setContentIntent(openPending)
            .addAction(android.R.drawable.ic_media_pause, "توقف گام‌شمار", stopPending).build()
    }

    private fun updateNotification(count: Int) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(count))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        sensorManager.unregisterListener(this)
        prefs.edit().putBoolean("step_service_active", false).apply()
        super.onDestroy()
    }
}