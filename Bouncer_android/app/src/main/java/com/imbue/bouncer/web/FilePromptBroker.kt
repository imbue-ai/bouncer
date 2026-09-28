package com.imbue.bouncer.web

import android.app.Activity
import android.content.Intent

/**
 * Bridges Gecko's file prompt (an `<input type="file">` tap, e.g. x.com's
 * media button) to Android's document picker, which only an Activity can
 * launch. MainActivity registers a launcher on create; the Gecko prompt
 * delegate calls [pick] from wherever it runs.
 */
object FilePromptBroker {

    /** Set by MainActivity: launches [Intent], invokes the callback with (resultCode, data). */
    @Volatile
    var launcher: ((Intent, onResult: (Int, Intent?) -> Unit) -> Unit)? = null

    fun pick(intent: Intent, onResult: (Int, Intent?) -> Unit) {
        val l = launcher
        if (l == null) {
            // No foreground activity to pick from.
            onResult(Activity.RESULT_CANCELED, null)
            return
        }
        l(intent, onResult)
    }
}
