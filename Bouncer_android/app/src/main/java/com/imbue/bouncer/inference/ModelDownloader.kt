package com.imbue.bouncer.inference

import android.content.Context
import android.os.StatFs
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Downloads model files (the ~2.2 GB .litertlm plus the small LoRA adapter) with
 * pause/resume. Mirrors the user-visible behavior of the iOS ModelDownloader, but
 * the mechanism is simpler: an OkHttp streaming GET writing to `<filename>.part`,
 * resumed via an HTTP `Range` request. The `.part` file itself is the persistent
 * resume state, so resume survives process death; a `<filename>.meta` sidecar
 * (etag + total size) guards against resuming across a changed remote file.
 *
 * v1 divergence from iOS: downloads only run while the app process is alive (no
 * background-transfer daemon on Android without a foreground service). A paused or
 * killed download resumes from the .part offset.
 */
class ModelDownloader(context: Context, private val scope: CoroutineScope) {
    private val tag = "ModelDownloader"

    sealed interface Status {
        object NotStarted : Status
        data class Downloading(val progress: Double) : Status
        data class Paused(val progress: Double) : Status
        object Completed : Status
        data class Failed(val message: String) : Status
    }

    // Excluded from Auto Backup / device-to-device transfer by location: the app has
    // allowBackup=true and a 2.2 GB blob must never be a backup candidate.
    val modelsDirectory: File = File(context.noBackupFilesDir, "litertlm/models")

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        // Streaming body reads; generous read timeout for stalled CDNs.
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private var transferJob: Job? = null

    // All mutable state below is only touched on the main thread (scope is
    // Main-dispatched from BouncerApplication); observers read via listeners.
    var status: Status = Status.NotStarted
        private set
    var downloadedBytes: Long = 0
        private set
    var totalBytes: Long = 0
        private set

    /** Invoked on the main thread whenever status/progress changes. */
    var onStateChanged: (() -> Unit)? = null

    init {
        modelsDirectory.mkdirs()
    }

    fun modelPath(filename: String): File = File(modelsDirectory, filename)
    fun isDownloaded(filename: String): Boolean = modelPath(filename).exists()

    private fun partFile(filename: String) = File(modelsDirectory, "$filename.part")
    private fun metaFile(filename: String) = File(modelsDirectory, "$filename.meta")

    /** Restores Paused/Completed state for the given model's main file on startup. */
    fun reconcile(model: LocalModel) {
        status = when {
            isDownloaded(model.filename) -> Status.Completed
            partFile(model.filename).exists() -> {
                val meta = readMeta(model.filename)
                totalBytes = meta?.optLong("totalBytes") ?: 0
                downloadedBytes = partFile(model.filename).length()
                Status.Paused(progressOf(downloadedBytes, totalBytes))
            }
            else -> Status.NotStarted
        }
        notifyChanged()
    }

    /**
     * Downloads the model file and then, if present, its LoRA adapter. Progress and
     * status reflect the main model file (the adapter is ~10 MB and rides the tail
     * end of the Downloading state, as on iOS).
     */
    fun startDownload(model: LocalModel) {
        if (transferJob?.isActive == true) return
        if (isDownloaded(model.filename) && adapterDownloaded(model)) {
            status = Status.Completed
            notifyChanged()
            return
        }
        val free = StatFs(modelsDirectory.path).availableBytes
        val needed = (model.approxSizeBytes * 1.05).toLong() - partFile(model.filename).length()
        if (!isDownloaded(model.filename) && free < needed) {
            status = Status.Failed("Not enough storage — needs ${model.approxSize} free")
            notifyChanged()
            return
        }

        status = Status.Downloading(progressOf(partFile(model.filename).length(), totalBytes))
        notifyChanged()
        transferJob = scope.launch {
            try {
                if (!isDownloaded(model.filename)) {
                    downloadFileWithRetry(model.url, model.filename)
                }
                if (model.adapterUrl != null && model.adapterFilename != null &&
                    !isDownloaded(model.adapterFilename)
                ) {
                    downloadFileWithRetry(model.adapterUrl, model.adapterFilename)
                }
                status = Status.Completed
                Log.i(tag, "download complete: ${model.filename}")
            } catch (e: CancellationException) {
                // pause() or cancel() already set the status.
                throw e
            } catch (e: Exception) {
                Log.w(tag, "download failed: ${model.filename}", e)
                status = Status.Failed(e.message ?: e.javaClass.simpleName)
            } finally {
                notifyChanged()
            }
        }
    }

    /** Pauses the in-flight download; the .part file is the resume state. */
    fun pause() {
        if (transferJob?.isActive != true) return
        transferJob?.cancel()
        transferJob = null
        status = Status.Paused(progressOf(downloadedBytes, totalBytes))
        notifyChanged()
    }

    /** Cancels the download and discards partial state. */
    fun cancel(model: LocalModel) {
        transferJob?.cancel()
        transferJob = null
        partFile(model.filename).delete()
        metaFile(model.filename).delete()
        model.adapterFilename?.let { partFile(it).delete(); metaFile(it).delete() }
        downloadedBytes = 0
        totalBytes = 0
        status = Status.NotStarted
        notifyChanged()
    }

    /** Deletes all downloaded/partial files for the model. */
    fun deleteModel(model: LocalModel) {
        cancel(model)
        modelPath(model.filename).delete()
        model.adapterFilename?.let { modelPath(it).delete() }
    }

    private fun adapterDownloaded(model: LocalModel) =
        model.adapterFilename == null || isDownloaded(model.adapterFilename)

    /**
     * Retries transient network failures (connection resets, stream errors from the
     * CDN on multi-GB transfers) with backoff; each attempt resumes from the .part
     * offset. Non-IO errors and HTTP failures surface immediately.
     */
    private suspend fun downloadFileWithRetry(url: String, filename: String) {
        var lastError: Exception? = null
        repeat(NETWORK_RETRIES) { attempt ->
            try {
                downloadFile(url, filename)
                return
            } catch (e: java.io.IOException) {
                lastError = e
                Log.w(tag, "download attempt ${attempt + 1}/$NETWORK_RETRIES failed for $filename", e)
                kotlinx.coroutines.delay(RETRY_BACKOFF_MS * (attempt + 1))
            }
        }
        throw lastError ?: IllegalStateException("download failed for $filename")
    }

    private suspend fun downloadFile(url: String, filename: String) {
        val part = partFile(filename)
        val meta = readMeta(filename)
        var offset = if (part.exists() && meta != null) part.length() else 0L
        if (part.exists() && meta == null) {
            // Partial file without metadata — can't validate; restart.
            part.delete()
            offset = 0
        }

        val request = Request.Builder().url(url).apply {
            if (offset > 0) {
                header("Range", "bytes=$offset-")
                meta?.optString("etag")?.takeIf { it.isNotEmpty() }?.let { header("If-Range", it) }
            }
        }.build()

        withContext(Dispatchers.IO) {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IllegalStateException("HTTP ${response.code} for $filename")
                }
                var writeOffset = offset
                if (offset > 0 && response.code != 206) {
                    // Server ignored the range (or the file changed): restart from scratch.
                    Log.w(tag, "resume rejected (HTTP ${response.code}); restarting $filename")
                    part.delete()
                    writeOffset = 0
                } else if (offset > 0) {
                    Log.i(tag, "resuming $filename at $offset (HTTP 206)")
                }

                val body = response.body ?: throw IllegalStateException("empty body for $filename")
                val total = writeOffset + body.contentLength().coerceAtLeast(0)
                writeMeta(filename, response.header("ETag").orEmpty(), total)
                postProgress(writeOffset, total, force = true)

                var lastDecile = -1
                part.parentFile?.mkdirs()
                java.io.RandomAccessFile(part, "rw").use { raf ->
                    raf.seek(writeOffset)
                    val buffer = ByteArray(8 * 1024 * 1024)
                    var written = writeOffset
                    body.byteStream().use { input ->
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            raf.write(buffer, 0, n)
                            written += n
                            postProgress(written, total)
                            val decile = if (total > 0) (written * 10 / total).toInt() else -1
                            if (decile != lastDecile) {
                                lastDecile = decile
                                Log.i(tag, "$filename ${decile * 10}% ($written / $total)")
                            }
                            // Bubble cancellation out of the tight read loop promptly.
                            if (!scope.isActive() || transferCancelled()) {
                                throw CancellationException("download paused")
                            }
                        }
                    }
                    if (total > 0 && written != total) {
                        throw IllegalStateException("short read for $filename: $written / $total")
                    }
                }
                if (!part.renameTo(modelPath(filename))) {
                    throw IllegalStateException("failed to move $filename into place")
                }
                metaFile(filename).delete()
            }
        }
    }

    private fun transferCancelled(): Boolean = transferJob?.isCancelled == true

    private fun CoroutineScope.isActive() = this.coroutineContext[Job]?.isActive != false

    private var lastProgressPost = 0L

    private suspend fun postProgress(written: Long, total: Long, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastProgressPost < 250) return
        lastProgressPost = now
        withContext(Dispatchers.Main) {
            downloadedBytes = written
            totalBytes = total
            if (status is Status.Downloading || force) {
                status = Status.Downloading(progressOf(written, total))
                notifyChanged()
            }
        }
    }

    private fun progressOf(written: Long, total: Long): Double =
        if (total > 0) (written.toDouble() / total).coerceIn(0.0, 1.0) else 0.0

    private fun readMeta(filename: String): JSONObject? =
        runCatching { JSONObject(metaFile(filename).readText()) }.getOrNull()

    private fun writeMeta(filename: String, etag: String, totalBytes: Long) {
        val obj = JSONObject().apply {
            put("etag", etag)
            put("totalBytes", totalBytes)
        }
        runCatching { metaFile(filename).writeText(obj.toString()) }
    }

    private fun notifyChanged() {
        onStateChanged?.invoke()
    }

    private companion object {
        const val NETWORK_RETRIES = 4
        const val RETRY_BACKOFF_MS = 2_000L
    }
}
