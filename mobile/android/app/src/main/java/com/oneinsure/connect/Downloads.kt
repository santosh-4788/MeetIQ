package com.oneinsure.connect

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File

/** Saves a page-made file (CSV, PDF...) to the phone's Downloads folder. */
object Downloads {
    fun save(context: Context, name: String, mime: String, bytes: ByteArray): Boolean = try {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no uri")
            resolver.openOutputStream(uri)!!.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } else {
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            dir.mkdirs()
            var file = File(dir, name)
            var i = 1
            while (file.exists()) file = File(dir, name.substringBeforeLast('.') + " (${i++})" + (if (name.contains('.')) "." + name.substringAfterLast('.') else ""))
            file.writeBytes(bytes)
        }
        true
    } catch (e: Exception) {
        Log.w("OicDownload", "save failed", e)
        false
    }
}
