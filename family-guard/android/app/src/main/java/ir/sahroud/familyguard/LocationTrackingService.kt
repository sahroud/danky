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
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONObject

class LocationTrackingService : Service(), LocationListener {
    companion object {
        const val ACTION_START = "ir.sahroud.familyguard.action.START_TRACKING"
        const val ACTION_STOP = "ir.sahroud.familyguard.action.STOP_TRACKING"
        const val ACTION_LOCATION_UPDATE = "ir.sahroud.familyguard.action.LOCATION_UPDATE"
        private const val CHANNEL_ID = "visible_location_tracking"
        private const val NOTIFICATION_ID = 7101
    }
    private val prefs by lazy { getSharedPreferences("sahroud_health", Context.MODE_PRIVATE) }
    private lateinit var locationManager: LocationManager
    private var previous: Location? = null
    private var totalDistance = 0f
    private val routePoints = mutableListOf<String>()
    private val uploadExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        totalDistance = prefs.getFloat("route_distance", 0f)
        routePoints.addAll(prefs.getString("route_points", "").orEmpty().split("|").filter { it.isNotBlank() })
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopTracking(); return START_NOT_STICKY }
            ACTION_START, null -> startTracking()
        }
        return START_NOT_STICKY
    }

    private fun startTracking() {
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) { stopSelf(); return }
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else startForeground(NOTIFICATION_ID, notification)
        try {
            val provider = if (fine && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
            locationManager.requestLocationUpdates(provider, 5000L, 3f, this, Looper.getMainLooper())
            locationManager.getLastKnownLocation(provider)?.let { onLocationChanged(it) }
            prefs.edit().putBoolean("tracking_active", true).apply()
        } catch (_: Exception) {
            prefs.edit().putBoolean("tracking_active", false).apply()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        sendBroadcast(Intent(ACTION_LOCATION_UPDATE).setPackage(packageName))
    }

    override fun onLocationChanged(location: Location) {
        if (location.accuracy > 75f) return
        previous?.let { old ->
            val delta = old.distanceTo(location)
            if (delta in 1f..500f) totalDistance += delta
        }
        previous = location
        val point = "${location.latitude},${location.longitude}"
        if (routePoints.isEmpty() || routePoints.last() != point) routePoints.add(point)
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
        prefs.edit().putFloat("route_distance", totalDistance)
            .putString("route_points", routePoints.joinToString("|"))
            .putString("last_lat", location.latitude.toString())
            .putString("last_lon", location.longitude.toString())
            .putString("last_location_time", time).putBoolean("tracking_active", true).apply()
        uploadLocation(location)
        sendBroadcast(Intent(ACTION_LOCATION_UPDATE).setPackage(packageName))
    }

    private fun uploadLocation(location: Location) {
        val secure = DeviceCredentials.get(this)
        val token = secure.getString("device_token", null) ?: return
        val api = prefs.getString("family_api_url", null) ?: return
        uploadExecutor.execute {
            var connection: java.net.HttpURLConnection? = null
            try {
                connection = (java.net.URL("$api/v1/location").openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 12000
                    doOutput = true
                    setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("Content-Type", "application/json")
                }
                val payload = JSONObject()
                    .put("latitude", location.latitude)
                    .put("longitude", location.longitude)
                    .put("accuracy_m", location.accuracy.toDouble())
                    .put("recorded_at", java.time.Instant.ofEpochMilli(location.time).toString())
                    .toString()
                connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code in 200..299) {
                    prefs.edit().putString("family_last_upload", Date().toString())
                        .remove("family_upload_error").apply()
                } else {
                    prefs.edit().putString("family_upload_error", "HTTP $code").apply()
                }
            } catch (e: Exception) {
                prefs.edit().putString("family_upload_error", e.javaClass.simpleName).apply()
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun stopTracking() {
        try { locationManager.removeUpdates(this) } catch (_: Exception) {}
        prefs.edit().putBoolean("tracking_active", false).putFloat("route_distance", totalDistance)
            .putString("route_points", routePoints.joinToString("|")).apply()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        sendBroadcast(Intent(ACTION_LOCATION_UPDATE).setPackage(packageName))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "ثبت آشکار موقعیت", NotificationManager.IMPORTANCE_LOW)
            channel.description = "اعلان دائمی هنگام ثبت مسیر توسط کاربر"
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, LocationTrackingService::class.java).setAction(ACTION_STOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        val stopPending = PendingIntent.getService(this, 7102, stopIntent, flags)
        val openPending = PendingIntent.getActivity(this, 7103, Intent(this, MainActivity::class.java), flags)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("SAHROUD FAMILY GUARD")
            .setContentText("ثبت موقعیت و مسیر فعال است؛ برای توقف از دکمه زیر استفاده کنید.")
            .setOngoing(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openPending)
            .addAction(android.R.drawable.ic_media_pause, "توقف ثبت مسیر", stopPending).build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        try { locationManager.removeUpdates(this) } catch (_: Exception) {}
        prefs.edit().putBoolean("tracking_active", false).apply()
        try { uploadExecutor.shutdown() } catch (_: Exception) {}
        super.onDestroy()
    }
}