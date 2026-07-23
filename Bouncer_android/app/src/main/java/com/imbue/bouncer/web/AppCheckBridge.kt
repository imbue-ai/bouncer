package com.imbue.bouncer.web

import android.app.Application
import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.imbue.bouncer.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

class AppCheckBridge(private val app: Application) {
    private val tag = "AppCheck"
    @Volatile private var cachedToken: String? = null
    @Volatile private var cachedAtMs: Long = 0L

    fun configure() {
        FirebaseApp.initializeApp(app)
        val factory = if (BuildConfig.DEBUG) {
            seedDebugTokenIfConfigured()
            DebugAppCheckProviderFactory.getInstance()
        } else {
            PlayIntegrityAppCheckProviderFactory.getInstance()
        }
        Log.i(
            tag,
            "configure: DEBUG=${BuildConfig.DEBUG} factory=${factory::class.simpleName} " +
                "debugTokenLen=${BuildConfig.APP_CHECK_DEBUG_TOKEN.length}",
        )
        FirebaseAppCheck.getInstance().installAppCheckProviderFactory(factory)
        // Warm the cache so the first WS open already has a token in hand.
        FirebaseAppCheck.getInstance().getAppCheckToken(false)
            .addOnSuccessListener {
                cachedToken = it.token
                cachedAtMs = System.currentTimeMillis()
                Log.i(tag, "warmup ok len=${it.token.length}")
            }
            .addOnFailureListener { Log.w(tag, "warmup failed", it) }
    }

    fun invalidate() {
        cachedToken = null
        cachedAtMs = 0L
    }

    suspend fun currentToken(): String? {
        cachedToken?.let {
            if (System.currentTimeMillis() - cachedAtMs < CACHE_TTL_MS) return it
        }
        return fetchAndCache()
    }

    private suspend fun fetchAndCache(): String? = withTimeoutOrNull(8_000) {
        suspendCancellableCoroutine { cont ->
            FirebaseAppCheck.getInstance().getAppCheckToken(false)
                .addOnSuccessListener {
                    cachedToken = it.token
                    cachedAtMs = System.currentTimeMillis()
                    cont.resume(it.token)
                }
                .addOnFailureListener { e ->
                    Log.w(tag, "getAppCheckToken failed", e)
                    cont.resume(null)
                }
        }
    }

    private fun seedDebugTokenIfConfigured() {
        val token = BuildConfig.APP_CHECK_DEBUG_TOKEN
        if (token.isBlank()) return
        val firebaseApp = FirebaseApp.getInstance()
        val persistenceKey = FirebaseApp.getPersistenceKey(firebaseApp.name, firebaseApp.options)
        val prefs = app.getSharedPreferences(
            "com.google.firebase.appcheck.debug.store.$persistenceKey",
            Context.MODE_PRIVATE,
        )
        prefs.edit()
            .putString("com.google.firebase.appcheck.debug.DEBUG_SECRET", token)
            .apply()
    }

    companion object {
        private const val CACHE_TTL_MS = 50L * 60L * 1000L
    }
}
