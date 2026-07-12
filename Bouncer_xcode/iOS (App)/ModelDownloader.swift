//
//  ModelDownloader.swift
//  iOS (App)
//
//  Downloads `.litertlm` model files with progress tracking, pause/resume, and
//  cancellation. Uses a background URLSession so iOS keeps downloading while
//  the app is suspended or terminated.
//
//  Singleton because background URLSessions are addressed by identifier:
//  iOS routes every delegate callback for `sessionIdentifier` to whichever
//  instance binds that identifier. Two instances would race for events.
//

import Foundation

@Observable
public final class ModelDownloader: NSObject, @unchecked Sendable {

    // MARK: - Types

    public enum DownloadStatus: Sendable, Equatable {
        case notStarted
        case downloading(progress: Double)
        case paused(progress: Double)
        case completed
        case failed(String)
    }

    public enum DownloadError: LocalizedError {
        case invalidHTTPResponse(Int)
        case fileOperationFailed(String)
        case alreadyDownloading

        public var errorDescription: String? {
            switch self {
            case .invalidHTTPResponse(let code): "Server returned HTTP \(code)"
            case .fileOperationFailed(let reason): reason
            case .alreadyDownloading: "A download is already in progress"
            }
        }
    }

    // MARK: - Singleton + background-session handoff

    public static let sessionIdentifier = "com.imbue.bouncer.model-download"
    public static let shared = ModelDownloader()

    // AppDelegate stashes the system handler here when iOS relaunches the
    // app to deliver background events. We invoke it once the URLSession
    // reports all events have been processed (see urlSessionDidFinishEvents).
    public var backgroundEventsCompletionHandler: (() -> Void)?

    // MARK: - Properties

    public var status: DownloadStatus = .notStarted
    public var downloadedBytes: Int64 = 0
    public var totalBytes: Int64 = 0

    public var progress: Double {
        guard totalBytes > 0 else { return 0 }
        return min(Double(downloadedBytes) / Double(totalBytes), 1.0)
    }

    public var isDownloaded: Bool {
        FileManager.default.fileExists(atPath: modelPath.path)
    }

    public static let defaultModelFilename = "model-e2b-detector-v2.litertlm"

    // The model file this downloader is currently targeting for download /
    // pause / delete / status. Set by LocalInferenceService before a download
    // so multiple on-device variants can coexist on disk under distinct
    // filenames. Persisted in UserDefaults because iOS can relaunch the app in
    // the background to deliver a finished transfer — in that path this
    // singleton is constructed before LocalInferenceService, and a completed
    // task with no in-memory taskFilenames entry falls back to this value.
    // Changes are REFUSED while a download task is active: completion already
    // moves the finished file per the task's pinned filename, but
    // pause/cancel/status would silently retarget the wrong variant.
    private static let activeFilenameDefaultsKey = "modelDownloadTargetFilename"
    public var activeFilename: String =
        UserDefaults.standard.string(forKey: ModelDownloader.activeFilenameDefaultsKey)
            ?? ModelDownloader.defaultModelFilename {
        didSet {
            guard oldValue != activeFilename else { return }
            if withLock({ activeTask != nil || continuation != nil }) {
                print("[ModelDownloader] WARN: activeFilename change to \(activeFilename) refused — download in progress")
                // Assigning within didSet does not re-trigger observers.
                activeFilename = oldValue
                return
            }
            // Drop the in-memory resume blob so we don't reuse one variant's
            // partial download for another (on-disk resume files are
            // per-filename; see resumeDataPath).
            withLock { resumeData = nil }
            UserDefaults.standard.set(activeFilename, forKey: Self.activeFilenameDefaultsKey)
        }
    }

    // Shown by totalBytesDisplay before the transfer reports a real total.
    // Set by LocalInferenceService per model (approxSize estimate).
    public var totalBytesFallbackDisplay: String = "~2.2 GB"

    public let modelsDirectory: URL

    public var modelPath: URL {
        modelsDirectory.appendingPathComponent(activeFilename)
    }

    // Path for an arbitrary variant filename (used by LocalInferenceService to
    // load the SELECTED model's file, which may differ from the active
    // download target).
    public func modelPath(for filename: String) -> URL {
        modelsDirectory.appendingPathComponent(filename)
    }

    // Whether a specific variant's file is on disk (independent of which one
    // is the active download target).
    public func isDownloaded(_ filename: String) -> Bool {
        FileManager.default.fileExists(atPath: modelPath(for: filename).path)
    }

    private var _session: URLSession?
    private var session: URLSession {
        if let s = _session { return s }
        // Background config: iOS keeps the transfer alive in nsurlsessiond
        // even when the app is suspended or terminated. Delivery resumes
        // via delegate callbacks on next foreground (or background relaunch
        // via AppDelegate.handleEventsForBackgroundURLSession).
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false        // user is actively waiting
        config.sessionSendsLaunchEvents = true // wake the app on completion
        config.timeoutIntervalForResource = 7 * 24 * 3600 // 1 week
        let s = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        _session = s
        return s
    }

    private var activeTask: URLSessionDownloadTask?
    private var continuation: CheckedContinuation<Void, any Error>?
    private let lock = NSLock()

    private var resumeData: Data?
    // Bumped by cancel(). pause()'s async cancel-with-resume completion handler
    // checks it before persisting its blob: if a cancel intervened, the blob is
    // discarded instead of saved. Without this, a stale blob survives the
    // cancel and the NEXT download "resumes" a dead transfer — splicing
    // mismatched bytes into the file (observed: correct total size, corrupt
    // content, engine "Failed to load model from buffer").
    private var cancelGeneration = 0
    // Destination filename per task, captured at task creation (see download()).
    // Lock-protected; read by didFinishDownloadingTo on the delegate queue.
    // Tasks reattached after an app relaunch (reconcileWithSession) have no
    // entry and fall back to activeFilename — the pre-existing behavior.
    private var taskFilenames: [Int: String] = [:]
    private var isPausing = false
    private var resumeOffset: Int64 = 0
    private var knownTotal: Int64 = 0
    // Last logged progress decile (0…10). Used to throttle the per-tick
    // "Progress" prints to once per 10% so the log doesn't flood.
    private var lastLoggedDecile: Int = -1
    // Lock-protected live progress. didWriteData updates these on the
    // URLSession bg queue BEFORE dispatching to main; pause()'s cancel
    // handler reads them from any thread without racing the dispatch
    // queue that backs downloadedBytes/totalBytes (the @Observable
    // stored properties).
    private var _liveDownloaded: Int64 = 0
    private var _liveTotal: Int64 = 0

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: - Init

    private override init() {
        self.modelsDirectory = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiteRTLM/Models", isDirectory: true)
        super.init()

        if isDownloaded {
            status = .completed
        } else if loadResumeData() != nil {
            let meta = loadResumeMetadata()
            status = .paused(progress: meta?.progress ?? 0)
            if let meta {
                downloadedBytes = meta.downloadedBytes
                totalBytes = meta.totalBytes
            }
        }

        // Eagerly construct the URLSession so iOS binds delegate callbacks
        // to this instance immediately. Critical for background relaunch:
        // without this, events for our session identifier would queue with
        // nowhere to go.
        _ = session
    }

    // MARK: - Reconcile

    // Re-attach to any in-flight background download task and reflect the
    // correct UI status. Call on app foreground or when the settings page
    // re-appears, since the foreground app process may have been killed
    // and relaunched while iOS continued the transfer.
    public func reconcileWithSession() async {
        let tasks = await session.allTasks
        let pending = tasks.compactMap { $0 as? URLSessionDownloadTask }
            .first { $0.state == .running || $0.state == .suspended }

        if let dl = pending {
            withLock { activeTask = dl }
            await MainActor.run {
                if status != .completed {
                    self.status = .downloading(progress: self.progress)
                }
            }
            print("[ModelDownloader] Reattached to in-flight download task")
            return
        }

        await MainActor.run {
            if isDownloaded {
                status = .completed
            } else if loadResumeData() != nil {
                let meta = loadResumeMetadata()
                if let meta {
                    downloadedBytes = meta.downloadedBytes
                    totalBytes = meta.totalBytes
                }
                status = .paused(progress: meta?.progress ?? progress)
            } else {
                status = .notStarted
                downloadedBytes = 0
                totalBytes = 0
            }
        }
    }

    // MARK: - Download

    public func download(from url: URL) async throws {
        guard !isDownloaded else {
            print("[ModelDownloader] Model already on disk, skipping download")
            status = .completed
            return
        }

        let isActive = withLock { continuation != nil || activeTask != nil }
        guard !isActive else {
            throw DownloadError.alreadyDownloading
        }

        status = .downloading(progress: progress)

        try FileManager.default.createDirectory(
            at: modelsDirectory, withIntermediateDirectories: true
        )

        let task: URLSessionDownloadTask
        if let data = loadResumeData() {
            task = session.downloadTask(withResumeData: data)
            print("[ModelDownloader] Resuming download")
        } else {
            task = session.downloadTask(with: url)
            print("[ModelDownloader] Starting download from \(url.absoluteString)")
        }

        withLock {
            activeTask = task
            resumeOffset = 0
            knownTotal = 0
            lastLoggedDecile = -1
            // Pin the task to its destination filename NOW. The completion
            // handler must NOT read activeFilename at finish time: for
            // multi-file downloads (model then adapter) the UI can flip
            // activeFilename mid-flight (e.g. selectModel while the adapter
            // is still downloading), and the finished blob would be moved
            // over the WRONG file — this clobbered a 2.2 GB model with its
            // 10 MB adapter (engine then failed with "Invalid magic: TFL3").
            taskFilenames[task.taskIdentifier] = activeFilename
            // Note: don't reset _liveDownloaded/_liveTotal here. On resume,
            // we want them to retain the last-known progress so any read
            // between resume and the first new didWriteData reflects the
            // pre-pause value, not 0.
        }

        return try await withCheckedThrowingContinuation { cont in
            withLock { continuation = cont }
            task.resume()
        }
    }

    // MARK: - Pause / Resume / Cancel

    public func pause() {
        guard let task = activeTask else { return }
        let generationAtPause = withLock { () -> Int in
            isPausing = true
            return cancelGeneration
        }
        // Cancel-with-resume's completion handler is the source of truth
        // for both the resume blob AND the UI transition to .paused.
        // didCompleteWithError fires separately (possibly first); it
        // tears down the task but no longer mutates UI state — that
        // ordering would expose the Resume button before the blob lands
        // on disk and let the user race past it.
        task.cancel(byProducingResumeData: { [weak self] data in
            guard let self else { return }
            // If the user hit Cancel while this pause was completing, the
            // cancel already cleared all resume state — persisting this blob
            // now would resurrect a dead transfer and corrupt the next
            // download. Discard it and leave the cancel's .notStarted intact.
            guard self.withLock({ self.cancelGeneration == generationAtPause }) else {
                print("[ModelDownloader] Pause resume-data discarded (cancel intervened)")
                return
            }
            // Read the latest progress from lock-protected fields. These
            // are committed synchronously by didWriteData on this same
            // queue, so they're always current — unlike the @Observable
            // downloadedBytes/totalBytes which lag behind by one main
            // runloop iteration.
            let (snapshotDownloaded, snapshotTotal) = self.withLock {
                (self._liveDownloaded, self._liveTotal)
            }
            let snapshotProgress = snapshotTotal > 0
                ? min(Double(snapshotDownloaded) / Double(snapshotTotal), 1.0)
                : 0
            if let data {
                self.saveResumeData(data, downloaded: snapshotDownloaded, total: snapshotTotal)
                print("[ModelDownloader] Resume data saved: \(data.count) bytes at \(Int(snapshotProgress * 100))%")
            } else {
                print("[ModelDownloader] WARN: Pause produced no resume data — restart from 0 on resume")
            }
            DispatchQueue.main.async {
                self.downloadedBytes = snapshotDownloaded
                self.totalBytes = snapshotTotal
                self.status = .paused(progress: snapshotProgress)
            }
        })
    }

    public func cancel() {
        print("[ModelDownloader] Cancel")
        activeTask?.cancel()
        clearResumeData()
        status = .notStarted
        downloadedBytes = 0
        totalBytes = 0
        withLock {
            cancelGeneration += 1
            _liveDownloaded = 0
            _liveTotal = 0
        }
    }

    public func deleteModel() {
        try? FileManager.default.removeItem(at: modelPath)
        clearResumeData()
        status = .notStarted
        downloadedBytes = 0
        totalBytes = 0
        withLock {
            _liveDownloaded = 0
            _liveTotal = 0
        }
        print("[ModelDownloader] Model deleted")
    }

    // MARK: - Display Helpers

    public var downloadedBytesDisplay: String {
        ByteCountFormatter.string(fromByteCount: downloadedBytes, countStyle: .file)
    }

    public var totalBytesDisplay: String {
        guard totalBytes > 0 else { return totalBytesFallbackDisplay }
        return ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file)
    }

    // MARK: - Resume Data Persistence

    private var resumeDataDirectory: URL {
        modelsDirectory.appendingPathComponent(".resumedata", isDirectory: true)
    }

    // Per-variant resume files so pausing one model's download doesn't clobber
    // another's partial blob (filenames have no path separators — safe as a
    // single path component).
    private var resumeDataPath: URL {
        resumeDataDirectory.appendingPathComponent("\(activeFilename).resume")
    }

    private var resumeMetadataPath: URL {
        resumeDataDirectory.appendingPathComponent("\(activeFilename).meta")
    }

    private struct ResumeMetadata: Codable {
        let downloadedBytes: Int64
        let totalBytes: Int64
        var progress: Double {
            guard totalBytes > 0 else { return 0 }
            return Double(downloadedBytes) / Double(totalBytes)
        }
    }

    private func saveResumeData(_ data: Data, downloaded: Int64? = nil, total: Int64? = nil) {
        withLock { resumeData = data }
        do {
            try FileManager.default.createDirectory(at: resumeDataDirectory, withIntermediateDirectories: true)
            try data.write(to: resumeDataPath)
            // Explicit snapshots beat reading downloadedBytes/totalBytes
            // from the current queue: pause() runs this on URLSession's
            // background delegate queue, and the main-thread updates from
            // didWriteData may not be visible yet.
            let meta = ResumeMetadata(
                downloadedBytes: downloaded ?? downloadedBytes,
                totalBytes: total ?? totalBytes
            )
            if let metaData = try? JSONEncoder().encode(meta) {
                try? metaData.write(to: resumeMetadataPath)
            }
        } catch {
            print("[ModelDownloader] ERROR: Failed to save resume data: \(error.localizedDescription)")
        }
    }

    private func loadResumeData() -> Data? {
        if let data = withLock({ resumeData }) { return data }
        guard let data = try? Data(contentsOf: resumeDataPath) else { return nil }
        withLock { resumeData = data }
        return data
    }

    private func loadResumeMetadata() -> ResumeMetadata? {
        guard let data = try? Data(contentsOf: resumeMetadataPath),
              let meta = try? JSONDecoder().decode(ResumeMetadata.self, from: data) else { return nil }
        return meta
    }

    private func clearResumeData() {
        withLock { resumeData = nil }
        try? FileManager.default.removeItem(at: resumeDataPath)
        try? FileManager.default.removeItem(at: resumeMetadataPath)
    }

    private func finish(result: Result<Void, any Error>) {
        let cont = withLock {
            let c = continuation
            continuation = nil
            if let task = activeTask {
                taskFilenames[task.taskIdentifier] = nil
            }
            activeTask = nil
            resumeOffset = 0
            knownTotal = 0
            return c
        }
        cont?.resume(with: result)
    }
}

// MARK: - URLSessionDownloadDelegate

extension ModelDownloader: URLSessionDownloadDelegate {

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        if let http = downloadTask.response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode) {
            print("[ModelDownloader] ERROR: Download failed: HTTP \(http.statusCode)")
            DispatchQueue.main.async { self.status = .failed("HTTP \(http.statusCode)") }
            finish(result: .failure(DownloadError.invalidHTTPResponse(http.statusCode)))
            return
        }

        // `location` is deleted as soon as this delegate returns, so move
        // synchronously on the delegate queue before doing anything else.
        // Destination = the filename pinned at task creation, NOT the current
        // activeFilename (which the UI may have flipped mid-flight).
        let destination = withLock {
            taskFilenames[downloadTask.taskIdentifier].map(modelPath(for:))
        } ?? modelPath
        do {
            try FileManager.default.createDirectory(
                at: modelsDirectory, withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)

            print("[ModelDownloader] Download completed → \(destination.lastPathComponent)")
            clearResumeData()
            DispatchQueue.main.async { self.status = .completed }
            finish(result: .success(()))
        } catch {
            print("[ModelDownloader] ERROR: File move failed: \(error.localizedDescription)")
            DispatchQueue.main.async { self.status = .failed(error.localizedDescription) }
            finish(result: .failure(DownloadError.fileOperationFailed(error.localizedDescription)))
        }
    }

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }

        // Apple's docs say totalBytesWritten is cumulative including the
        // resume offset, but empirically on background URLSessions iOS
        // sometimes reports bytes-since-resume (relative). The disambiguator:
        //   * If totalBytesWritten alone already places us past the offset,
        //     iOS is using absolute and we use it directly.
        //   * Otherwise iOS is using relative and we add the offset.
        // Then clamp to total to prevent any overshoot from leaking into UI
        // if iOS misbehaves under heavy background batching.
        let offset = withLock { resumeOffset }
        let total = withLock { knownTotal > 0 ? knownTotal : totalBytesExpectedToWrite }
        let raw: Int64 = (totalBytesWritten >= offset && offset > 0)
            ? totalBytesWritten            // iOS reporting absolute
            : (offset + totalBytesWritten) // iOS reporting bytes-since-resume
        let downloaded = total > 0 ? min(raw, total) : raw
        let prog = total > 0 ? min(Double(downloaded) / Double(total), 1.0) : 0
        if raw != downloaded {
            print("[ModelDownloader] WARN: progress overshoot clamped: raw=\(raw) total=\(total) offset=\(offset) totalBytesWritten=\(totalBytesWritten)")
        }

        // Commit to lock-protected fields synchronously on this queue so
        // pause()'s cancel handler can read the latest values without
        // racing the main-queue dispatch below. Use the clamped value so
        // a saved resume blob never records bogus over-100% progress.
        withLock {
            _liveDownloaded = downloaded
            _liveTotal = total
        }

        let decile = Int(prog * 10)
        let shouldLog = withLock {
            if decile > lastLoggedDecile {
                lastLoggedDecile = decile
                return true
            }
            return false
        }
        if shouldLog {
            let dMB = Double(downloaded) / 1_048_576.0
            let tMB = Double(total) / 1_048_576.0
            print(String(format: "[ModelDownloader] Progress: %.0f%% (%.1f MB / %.1f MB)", prog * 100, dMB, tMB))
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.status = .downloading(progress: prog)
            self.downloadedBytes = downloaded
            self.totalBytes = total
        }
    }

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didResumeAtOffset fileOffset: Int64,
        expectedTotalBytes: Int64
    ) {
        print("[ModelDownloader] Resumed at offset \(ByteCountFormatter.string(fromByteCount: fileOffset, countStyle: .file))")
        withLock {
            resumeOffset = fileOffset
            if expectedTotalBytes > 0 { knownTotal = expectedTotalBytes }
        }
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        guard let error else { return }

        let isPause = withLock {
            let was = isPausing
            isPausing = false
            return was
        }
        let userInfoData = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data

        // Pause-initiated cancels deliver resume data via the
        // cancel(byProducingResumeData:) completion handler (see pause()).
        // System-induced suspensions (network loss, app killed mid-flight,
        // etc.) deliver it here in the error's userInfo.
        if !isPause, let userInfoData {
            saveResumeData(userInfoData)
        } else if !isPause {
            clearResumeData()
        }

        if isPause {
            // UI transition + status update happen in the cancel-with-resume
            // completion handler (see pause()), after saveResumeData lands.
            // Tearing down the task here without flipping status is what
            // keeps the Resume button hidden until the blob is on disk.
            print("[ModelDownloader] Paused")
            finish(result: .failure(CancellationError()))
        } else if (error as NSError).code == NSURLErrorCancelled {
            DispatchQueue.main.async { self.status = .notStarted }
            finish(result: .failure(CancellationError()))
        } else {
            print("[ModelDownloader] ERROR: Download error: \(error.localizedDescription)")
            DispatchQueue.main.async {
                if userInfoData != nil {
                    self.status = .paused(progress: self.progress)
                } else {
                    self.status = .failed(error.localizedDescription)
                }
            }
            finish(result: .failure(error))
        }
    }

    // Called by iOS after all background-session events have been
    // delivered to the delegate. We invoke the AppDelegate's stashed
    // system handler so iOS can take the app snapshot and re-suspend.
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        print("[ModelDownloader] Background URLSession events delivered")
        DispatchQueue.main.async { [weak self] in
            let handler = self?.backgroundEventsCompletionHandler
            self?.backgroundEventsCompletionHandler = nil
            handler?()
        }
    }
}
