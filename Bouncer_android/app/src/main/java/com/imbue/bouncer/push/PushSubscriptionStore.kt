package com.imbue.bouncer.push

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.security.interfaces.ECPublicKey

/**
 * Persists Web Push subscriptions keyed by service-worker scope. Each record
 * holds the P-256 keypair + auth secret this app generated for the site (we
 * are the "browser", so we hold the private half that decrypts pushes) plus
 * the endpoint the site's server delivers to.
 */
class PushSubscriptionStore(ctx: Context) {

    data class Record(
        /** Opaque id embedded in the endpoint URL; maps incoming pushes back to the scope. */
        val id: String,
        val scope: String,
        val endpoint: String,
        val appServerKey: ByteArray?,
        val publicKeyUncompressed: ByteArray,
        val privateKeyPkcs8: ByteArray,
        val authSecret: ByteArray,
    )

    private val prefs: SharedPreferences by lazy {
        val master = MasterKey.Builder(ctx.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx.applicationContext,
            FILE,
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    @Synchronized
    fun create(scope: String, id: String, endpoint: String, appServerKey: ByteArray?): Record {
        // Replacing a subscription must drop the old id index too.
        get(scope)?.let { prefs.edit().remove(ID_PREFIX + it.id).apply() }
        val keyPair = WebPushCrypto.generateKeyPair()
        val record = Record(
            id = id,
            scope = scope,
            endpoint = endpoint,
            appServerKey = appServerKey,
            publicKeyUncompressed =
                WebPushCrypto.encodeUncompressedPoint(keyPair.public as ECPublicKey),
            privateKeyPkcs8 = keyPair.private.encoded,
            authSecret = WebPushCrypto.generateAuthSecret(),
        )
        prefs.edit()
            .putString(keyFor(scope), encode(record))
            .putString(ID_PREFIX + id, scope)
            .apply()
        return record
    }

    @Synchronized
    fun get(scope: String): Record? =
        prefs.getString(keyFor(scope), null)?.let { decode(scope, it) }

    @Synchronized
    fun scopeForId(id: String): String? = prefs.getString(ID_PREFIX + id, null)

    @Synchronized
    fun remove(scope: String) {
        val id = get(scope)?.id
        prefs.edit().apply {
            remove(keyFor(scope))
            id?.let { remove(ID_PREFIX + it) }
        }.apply()
    }

    /** All scopes with a live subscription — used to invalidate on FCM token rotation. */
    @Synchronized
    fun scopes(): List<String> =
        prefs.all.keys.filter { it.startsWith(KEY_PREFIX) }.map { it.removePrefix(KEY_PREFIX) }

    /** Debug-build diagnostics: log every stored subscription's scope + endpoint + VAPID key. */
    fun dumpToLog(tag: String) {
        scopes().forEach { scope ->
            val r = get(scope) ?: return@forEach
            android.util.Log.i(
                tag,
                "subscription: scope=$scope endpoint=${r.endpoint} " +
                    "appServerKey=${r.appServerKey?.let { b64(it) }}",
            )
        }
    }

    private fun keyFor(scope: String) = KEY_PREFIX + scope

    private fun encode(r: Record): String = JSONObject().apply {
        put("id", r.id)
        put("endpoint", r.endpoint)
        put("appServerKey", r.appServerKey?.let { b64(it) } ?: JSONObject.NULL)
        put("publicKey", b64(r.publicKeyUncompressed))
        put("privateKey", b64(r.privateKeyPkcs8))
        put("authSecret", b64(r.authSecret))
    }.toString()

    private fun decode(scope: String, json: String): Record? = runCatching {
        val obj = JSONObject(json)
        Record(
            id = obj.getString("id"),
            scope = scope,
            endpoint = obj.getString("endpoint"),
            appServerKey = if (obj.isNull("appServerKey")) null else unb64(obj.getString("appServerKey")),
            publicKeyUncompressed = unb64(obj.getString("publicKey")),
            privateKeyPkcs8 = unb64(obj.getString("privateKey")),
            authSecret = unb64(obj.getString("authSecret")),
        )
    }.getOrNull()

    private fun b64(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE)

    companion object {
        private const val FILE = "bouncer_push_subscriptions"
        private const val KEY_PREFIX = "sub:"
        private const val ID_PREFIX = "id:"
    }
}
