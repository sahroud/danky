package ir.sahroud.familyguard

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.view.Gravity
import android.graphics.Color
import android.content.Intent
import android.net.Uri
import android.os.Looper

class MainActivity : Activity(), LocationListener {
    private lateinit var status: TextView
    private lateinit var coords: TextView
    private lateinit var locationManager: LocationManager
    private var sharing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 36, 28, 24)
            setBackgroundColor(Color.rgb(245, 248, 252))
        }
        val title = TextView(this).apply {
            text = "SAHROUD FAMILY GUARD"
            textSize = 22f
            setTextColor(Color.rgb(20, 65, 105))
            gravity = Gravity.CENTER
        }
        status = TextView(this).apply {
            text = "اشتراک‌گذاری موقعیت خاموش است"
            textSize = 17f
            setPadding(0, 32, 0, 20)
        }
        coords = TextView(this).apply {
            text = "برای شروع، رضایت خود را اعلام و مجوز مکان را صادر کنید."
            textSize = 15f
        }
        val consent = TextView(this).apply {
            text = "با لمس دکمه شروع، آگاهانه اجازه می‌دهم موقعیت این گوشی در همین دستگاه برای آزمایش نمایش داده شود. در این نسخه هنوز اطلاعاتی به سرور یا والدین ارسال نمی‌شود."
            textSize = 14f
            setTextColor(Color.DKGRAY)
            setPadding(0, 22, 0, 22)
        }
        val start = Button(this).apply {
            text = "شروع اشتراک‌گذاری آزمایشی"
            setOnClickListener { startSharing() }
        }
        val stop = Button(this).apply {
            text = "توقف اشتراک‌گذاری"
            setOnClickListener { stopSharing() }
        }
        val map = Button(this).apply {
            text = "نمایش آخرین موقعیت در نقشه"
            setOnClickListener {
                val text = coords.tag as? String
                if (text != null) {
                    val parts = text.split(",")
                    if (parts.size == 2) {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/?mlat=${parts[0]}&mlon=${parts[1]}#map=16/${parts[0]}/${parts[1]}")))
                    }
                }
            }
        }
        root.addView(title)
        root.addView(status)
        root.addView(coords)
        root.addView(consent)
        root.addView(start)
        root.addView(stop)
        root.addView(map)
        setContentView(root)
    }

    private fun startSharing() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 41)
            return
        }
        try {
            sharing = true
            status.text = "در حال دریافت موقعیت؛ اشتراک‌گذاری آزمایشی روشن است."
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 5f, this, Looper.getMainLooper())
            locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.let { onLocationChanged(it) }
        } catch (e: Exception) {
            status.text = "خطا در دریافت GPS: ${e.localizedMessage ?: "دسترسی ناموفق"}"
        }
    }

    private fun stopSharing() {
        sharing = false
        locationManager.removeUpdates(this)
        status.text = "اشتراک‌گذاری موقعیت متوقف شد."
    }

    override fun onLocationChanged(location: Location) {
        if (!sharing) return
        val lat = location.latitude.toString()
        val lon = location.longitude.toString()
        coords.text = "عرض جغرافیایی: $lat\nطول جغرافیایی: $lon\nدقت: ${location.accuracy.toInt()} متر"
        coords.tag = "$lat,$lon"
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 41 && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) startSharing()
        else status.text = "مجوز مکان داده نشد؛ اشتراک‌گذاری شروع نشد."
    }

    override fun onDestroy() {
        stopSharing()
        super.onDestroy()
    }
}
