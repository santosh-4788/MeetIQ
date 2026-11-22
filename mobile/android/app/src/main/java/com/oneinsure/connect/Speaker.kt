package com.oneinsure.connect

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Loudspeaker / earpiece switch for calls in the portal (bridge message {type:"speaker", on?}).
 * Android 12+ uses the communication-device API; older versions use speakerphone mode. The page always gets the
 * phone's real state back, so a phone without an earpiece (tablets) simply stays on the loudspeaker.
 * reset() hands routing back to the system when the call ends (headphones / Bluetooth keep working as normal).
 */
object Speaker {
    private var changedMode = false

    private fun audio(ctx: Context) = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    fun isOn(ctx: Context): Boolean {
        val am = audio(ctx)
        return if (Build.VERSION.SDK_INT >= 31) {
            am.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn
        }
    }

    /** Returns the state after the change. */
    fun set(ctx: Context, on: Boolean): Boolean {
        val am = audio(ctx)
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val want = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                val device = am.availableCommunicationDevices.firstOrNull { it.type == want }
                if (device != null) am.setCommunicationDevice(device)
            } else {
                if (am.mode != AudioManager.MODE_IN_COMMUNICATION) { am.mode = AudioManager.MODE_IN_COMMUNICATION; changedMode = true }
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = on
            }
        } catch (_: Exception) {
            // Routing refused by the system: report the unchanged state.
        }
        return isOn(ctx)
    }

    fun reset(ctx: Context) {
        val am = audio(ctx)
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
                if (changedMode) am.mode = AudioManager.MODE_NORMAL
            }
        } catch (_: Exception) {
        }
        changedMode = false
    }
}
