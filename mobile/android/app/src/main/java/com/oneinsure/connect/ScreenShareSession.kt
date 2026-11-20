package com.oneinsure.connect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Phone screen sharing. The meeting page itself runs in the WebView (which cannot capture the screen); this opens a
 * SECOND, screen-only connection to OUR video server with a short-lived token the portal obtained for the same person
 * (server: screen companion token - may publish only a screen, sees and hears nothing). Others see "<name> is presenting".
 *
 * Ends when: the user taps Stop (notification or meeting page), Android stops the capture, the connection drops, the
 * meeting page leaves or the app is closed. One session at a time.
 */
object ScreenShareSession {
    private const val TAG = "OicScreen"
    const val CHANNEL = "oic_screen"
    const val NOTIFICATION_ID = 4201
    const val ACTION_STOP = "com.oneinsure.connect.STOP_PRESENTING"

    enum class State { IDLE, STARTING, PRESENTING }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    // Holds the APPLICATION context only (LiveKit.create(app)) - lives as long as the process, which is intended.
    @android.annotation.SuppressLint("StaticFieldLeak")
    private var room: Room? = null
    private var eventsJob: Job? = null
    @Volatile var state: State = State.IDLE
        private set

    /** state, detail ("stopped" reason or error message) - the activity forwards it to the meeting page. */
    var listener: ((State, String?) -> Unit)? = null

    fun start(context: Context, url: String, token: String, name: String, projectionData: Intent) {
        stop("restart", notify = false)
        val app = context.applicationContext
        val r = LiveKit.create(app)
        // Readable text from a phone screen without flooding mobile data: up to 15 fps, 2.5 Mbps (the video server still
        // lowers it per viewer on weak links).
        r.screenShareTrackPublishDefaults = VideoTrackPublishDefaults(videoEncoding = VideoEncoding(2_500_000, 15))
        room = r
        update(State.STARTING, null)
        eventsJob = scope.launch {
            r.events.collect { e ->
                if (e is RoomEvent.Disconnected && room === r) stop("disconnected")
            }
        }
        scope.launch {
            try {
                r.connect(url, token)
                val ok = r.localParticipant.setScreenShareEnabled(
                    true,
                    ScreenCaptureParams(
                        mediaProjectionPermissionResultData = projectionData,
                        notificationId = NOTIFICATION_ID,
                        notification = notification(app, name),
                        onStop = { scope.launch { if (room === r) stop("capture_stopped") } },
                    ),
                )
                if (!ok) throw IllegalStateException("screen share not published")
                if (room === r) update(State.PRESENTING, null)
            } catch (e: Exception) {
                Log.w(TAG, "screen share failed", e)
                if (room === r) {
                    release(r)
                    update(State.IDLE, "error:" + (e.message ?: e.javaClass.simpleName).take(200))
                }
            }
        }
    }

    fun stop(reason: String, notify: Boolean = true) {
        val r = room ?: return
        release(r)
        if (notify) update(State.IDLE, reason) else state = State.IDLE
    }

    private fun release(r: Room) {
        room = null
        eventsJob?.cancel()
        eventsJob = null
        try {
            scope.launch {
                try { r.localParticipant.setScreenShareEnabled(false) } catch (_: Exception) {}
                r.disconnect()
                r.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "release failed", e)
        }
    }

    private fun update(s: State, detail: String?) {
        state = s
        listener?.invoke(s, detail)
    }

    private fun notification(context: Context, name: String): Notification {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_screen), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            context, 1, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getActivity(
            context, 2, Intent(context, MainActivity::class.java).setAction(ACTION_STOP).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val who = UrlPolicy.safeName(name)
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_meeting)
            .setContentTitle(context.getString(R.string.screen_notification_title))
            .setContentText(if (who.isEmpty()) context.getString(R.string.screen_notification_text) else "$who · " + context.getString(R.string.screen_notification_text))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.stop_presenting), stop)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
    }
}
