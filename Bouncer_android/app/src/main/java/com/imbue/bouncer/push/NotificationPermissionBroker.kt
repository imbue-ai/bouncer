package com.imbue.bouncer.push

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Bridges Gecko's content-level notification permission (the site asking) to
 * Android's runtime POST_NOTIFICATIONS permission (API 33+), which only an
 * Activity can request. MainActivity registers a requester on create; the
 * Gecko permission delegate calls [ensurePermission] from wherever it runs.
 */
object NotificationPermissionBroker {

    /** Set by MainActivity: launches the system permission dialog, invokes the callback with the result. */
    @Volatile
    var requester: ((onResult: (Boolean) -> Unit) -> Unit)? = null

    fun hasPermission(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun ensurePermission(ctx: Context, onResult: (Boolean) -> Unit) {
        if (hasPermission(ctx)) {
            onResult(true)
            return
        }
        val r = requester
        if (r == null) {
            // No foreground activity to ask from; don't grant the site
            // permission we can't honor.
            onResult(false)
            return
        }
        r(onResult)
    }
}
