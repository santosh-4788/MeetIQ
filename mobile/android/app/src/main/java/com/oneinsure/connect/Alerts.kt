package com.oneinsure.connect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Phone notifications for tasks and reminders (app 1.2.0, 21 Nov 2026). The portal page asks for one through the bridge
 * ({type:"notify"}) when it receives a task alert or a reminder while the app is in the background. Tapping it opens that
 * page in the app. Only links to our own portal are used; anything else opens the portal home. No cloud push service:
 * notifications come from the app's own live connection while it runs.
 */
object Alerts {
    const val CHANNEL = "oic_tasks"

    fun canPost(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun show(context: Context, title: String, body: String, link: String, tag: String) {
        if (!canPost(context)) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_tasks), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channel_tasks_description)
        })
        val target = if (UrlPolicy.classify(link, BuildConfig.PORTAL_HOST, BuildConfig.PORTAL_PATH) == UrlPolicy.Action.INSIDE) link else BuildConfig.PORTAL_URL
        val id = tag.ifBlank { title }.hashCode()
        val open = PendingIntent.getActivity(
            context, id,
            Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(target)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_task)
            .setContentTitle(title.take(120))
            .setContentText(body.take(240))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setContentIntent(open)
            .build()
        try { NotificationManagerCompat.from(context).notify(id, n) } catch (_: SecurityException) { }
    }
}
