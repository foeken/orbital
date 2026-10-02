package com.dreetje.orbital.android

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import com.dreetje.orbital.Recorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

// A shake of the phone: what is sensitive shown, and hidden again by the next (the iPhone's motionShake)
class Shake(context: Context, private val shaken: () -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(SensorManager::class.java)
    private var last = 0L

    fun on() { sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) } }
    fun off() { sensors?.unregisterListener(this) }

    override fun onSensorChanged(event: SensorEvent) {
        val (x, y, z) = event.values
        val g = sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH
        // ponytail: 2.5 g once a second; a tuned shake (count, direction) if this one fires in a pocket
        if (g > 2.5f && event.timestamp / 1_000_000 - last > 1000) { last = event.timestamp / 1_000_000; shaken() }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}

// The microphone for dictation: AAC mono at 44.1 kHz in an .m4a, small to send (the iPhone's AVAudioRecorder), its level
// sampled for the dots that move while you speak
class MicRecorder(private val context: Context) : Recorder {
    private var recorder: MediaRecorder? = null
    private val file = File(context.cacheDir, "dictation.m4a")

    override fun start() {
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(44100)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(64000)
            r.setOutputFile(file.path)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            throw IllegalStateException("The microphone did not start")
        }
        recorder = r
    }

    // -50 dB is silence
    override fun level(): Float {
        val amp = recorder?.maxAmplitude ?: 0
        if (amp <= 0) return 0f
        return ((20 * log10(amp / 32767.0) + 50) / 45).coerceIn(0.0, 1.0).toFloat()
    }

    override fun stop(): ByteArray? {
        val r = recorder ?: return null
        recorder = null
        return try { r.stop(); file.readBytes() } catch (e: RuntimeException) { null } finally { r.release(); file.delete() }
    }

    override fun cancel() {
        recorder?.let { runCatching { it.stop() }; it.release() }
        recorder = null
        file.delete()
    }
}

// An image for the model and for Tana: 2048 px at most on its longest side, as a JPEG (the iPhone's UIImage.fitted)
object Images {
    suspend fun jpeg(resolver: ContentResolver, uri: Uri): ByteArray? = withContext(Dispatchers.IO) { runCatching { jpegNow(resolver, uri) }.getOrNull() }

    fun jpegNow(resolver: ContentResolver, uri: Uri): ByteArray {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            val k = minOf(1.0, 2048.0 / max(info.size.width, info.size.height))
            decoder.setTargetSize(max(1, (info.size.width * k).toInt()), max(1, (info.size.height * k).toInt()))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    }
}
