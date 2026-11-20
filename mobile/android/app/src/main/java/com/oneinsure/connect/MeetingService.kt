package com.oneinsure.connect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Runs while the user is in a meeting (the meeting page tells the app through the bridge). Android stops the microphone
 * of an app in the background unless it shows an ongoing notification; with this, the other participants keep hearing
 * the user while they briefly open another app (e.g. WhatsApp to send the link). Camera video pauses in the background
 * (Android rule) and resumes when the user comes back. Stopped when the meeting page is left or the app is closed.
 */
class MeetingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_meeting), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_meeting)
            .setContentTitle(getString(R.string.meeting_notification_title))
            .setContentText(getString(R.string.meeting_notification_text))
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
        try {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
        } catch (e: Exception) {
            // e.g. microphone permission not granted yet: the meeting works, only background audio is not kept.
            Log.w("OicMeeting", "foreground not started", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf() // app swiped away: no lingering notification
    }

    companion object {
        private const val CHANNEL = "oic_meeting"
        private const val NOTIFICATION_ID = 4101
        private const val ACTION_STOP = "stop"

        fun start(context: Context) {
            // Only with the microphone permission (Android requires it for a microphone foreground service).
            if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
            ContextCompat.startForegroundService(context, Intent(context, MeetingService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MeetingService::class.java))
        }
    }
}
