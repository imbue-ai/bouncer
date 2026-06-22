//
//  ModelDownloader.swift
//  iOS (App)
//
//  Downloads `.litertlm` model files with progress tracking, pause/resume, and
//  cancellation. Ported from the (now-retired) imbue-ai/LiteRTLM Swift package
//  so we can drop that dependency in favor of the first-party
//  google-ai-edge/LiteRT-LM package, which does not ship a downloader.
//
//  The on-disk location and filename are kept identical to the previous
//  implementation so that already-downloaded model files on user devices are
//  re-used rather than re-downloaded.
//

import Foundation
import os

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

    // Versioned per model URL: bump when switching modelURL in
    // LocalInferenceService so the downloader treats it as a fresh fetch
    // instead of reusing a previously downloaded variant under the old name.
    // Upstream Gemma 4 E4B IT — single-signature litertlm hosted by the LiteRT
    // community. Classification head runs in Swift on the chat decode "logits"
    // aux output rather than a baked-in classifier_logits signature.
    public static let defaultModelFilename = "gemma-4-E4B-it.litertlm"

    public let modelsDirectory: URL

    public var modelPath: URL {
        modelsDirectory.appendingPathComponent(Self.defaultModelFilename)
    }

    private var _session: URLSession?
    private var session: URLSession {
        if let s = _session { return s }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForResource = 3600
        config.httpMaximumConnectionsPerHost = 2
        let s = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        _session = s
        return s
    }

    private var activeTask: URLSessionDownloadTask?
    private var continuation: CheckedContinuation<Void, any Error>?
    private let lock = NSLock()

    private var resumeData: Data?
    private var isPausing = false
    private var resumeOffset: Int64 = 0
    private var knownTotal: Int64 = 0

    private static let log = Logger(subsystem: "Bouncer.ModelDownloader", category: "Downloader")

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: - Init

    public init(modelsDirectory: URL? = nil) {
        self.modelsDirectory = modelsDirectory ?? FileManager.default
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
    }

    // MARK: - Download

    public func download(from url: URL) async throws {
        guard !isDownloaded else {
            Self.log.info("Model already on disk, skipping download")
            status = .completed
            return
        }

        let isActive = withLock { continuation != nil }
        guard !isActive else {
            throw DownloadError.alreadyDownloading
        }

        status = .downloading(progress: 0)

        try FileManager.default.createDirectory(
            at: modelsDirectory, withIntermediateDirectories: true
        )

        let task: URLSessionDownloadTask
        if let data = loadResumeData() {
            task = session.downloadTask(withResumeData: data)
            Self.log.info("Resuming download")
        } else {
            task = session.downloadTask(with: url)
            Self.log.info("Starting download from \(url.absoluteString)")
        }

        withLock {
            activeTask = task
            resumeOffset = 0
            knownTotal = 0
        }

        return try await withCheckedThrowingContinuation { cont in
            withLock { continuation = cont }
            task.resume()
        }
    }

    // MARK: - Pause / Resume / Cancel

    public func pause() {
        withLock { isPausing = true }
        activeTask?.cancel(byProducingResumeData: { _ in })
    }

    public func cancel() {
        activeTask?.cancel()
        clearResumeData()
        status = .notStarted
        downloadedBytes = 0
        totalBytes = 0
    }

    public func deleteModel() {
        try? FileManager.default.removeItem(at: modelPath)
        clearResumeData()
        status = .notStarted
        downloadedBytes = 0
        totalBytes = 0
        Self.log.info("Model deleted")
    }

    // MARK: - Display Helpers

    public var downloadedBytesDisplay: String {
        ByteCountFormatter.string(fromByteCount: downloadedBytes, countStyle: .file)
    }

    public var totalBytesDisplay: String {
        guard totalBytes > 0 else { return "~3.7 GB" }
        return ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file)
    }

    // MARK: - Resume Data Persistence

    private var resumeDataDirectory: URL {
        modelsDirectory.appendingPathComponent(".resumedata", isDirectory: true)
    }

    private var resumeDataPath: URL {
        resumeDataDirectory.appendingPathComponent("model.resume")
    }

    private var resumeMetadataPath: URL {
        resumeDataDirectory.appendingPathComponent("model.meta")
    }

    private struct ResumeMetadata: Codable {
        let downloadedBytes: Int64
        let totalBytes: Int64
        var progress: Double {
            guard totalBytes > 0 else { return 0 }
            return Double(downloadedBytes) / Double(totalBytes)
        }
    }

    private func saveResumeData(_ data: Data) {
        withLock { resumeData = data }
        do {
            try FileManager.default.createDirectory(at: resumeDataDirectory, withIntermediateDirectories: true)
            try data.write(to: resumeDataPath)
            let meta = ResumeMetadata(downloadedBytes: downloadedBytes, totalBytes: totalBytes)
            if let metaData = try? JSONEncoder().encode(meta) {
                try? metaData.write(to: resumeMetadataPath)
            }
        } catch {
            Self.log.error("Failed to save resume data: \(error.localizedDescription)")
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
            Self.log.error("Download failed: HTTP \(http.statusCode)")
            status = .failed("HTTP \(http.statusCode)")
            finish(result: .failure(DownloadError.invalidHTTPResponse(http.statusCode)))
            return
        }

        do {
            if FileManager.default.fileExists(atPath: modelPath.path) {
                try FileManager.default.removeItem(at: modelPath)
            }
            try FileManager.default.moveItem(at: location, to: modelPath)

            Self.log.info("Download completed")
            clearResumeData()
            status = .completed
            finish(result: .success(()))
        } catch {
            Self.log.error("File move failed: \(error.localizedDescription)")
            status = .failed(error.localizedDescription)
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

        let offset = withLock { resumeOffset }
        let total = withLock { knownTotal > 0 ? knownTotal : (offset + totalBytesExpectedToWrite) }
        let downloaded = offset + totalBytesWritten
        let prog = total > 0 ? min(Double(downloaded) / Double(total), 1.0) : 0

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
        Self.log.info("Resumed at offset \(ByteCountFormatter.string(fromByteCount: fileOffset, countStyle: .file))")
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
        let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data

        if let data { saveResumeData(data) }
        else if !isPause { clearResumeData() }

        if isPause {
            Self.log.info("Download paused at \(Int(self.progress * 100))%")
            status = .paused(progress: progress)
            finish(result: .failure(CancellationError()))
        } else if (error as NSError).code == NSURLErrorCancelled {
            status = .notStarted
            finish(result: .failure(CancellationError()))
        } else {
            Self.log.error("Download error: \(error.localizedDescription)")
            if data != nil {
                status = .paused(progress: progress)
            } else {
                status = .failed(error.localizedDescription)
            }
            finish(result: .failure(error))
        }
    }
}
