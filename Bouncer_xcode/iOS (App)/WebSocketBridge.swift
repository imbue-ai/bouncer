//
//  WebSocketBridge.swift
//  iOS (App)
//
//  Native WebSocket bridge for WKWebView.
//  Bypasses page CSP by using URLSessionWebSocketTask on the native side.
//  JavaScript communicates via WKScriptMessageHandler; native sends events
//  back via evaluateJavaScript in the extension content world.
//

import WebKit

class WebSocketBridge: NSObject, URLSessionWebSocketDelegate {

    static let shared = WebSocketBridge()

    private var tasks: [String: URLSessionWebSocketTask] = [:]
    private var taskToSocketId: [ObjectIdentifier: String] = [:]
    weak var webView: WKWebView?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    // MARK: - JS → Native actions

    func open(socketId: String, urlString: String) {
        guard let url = URL(string: urlString) else {
            fireEvent(socketId: socketId, event: "error", data: "null")
            fireEvent(socketId: socketId, event: "close", code: 1006, wasClean: false)
            return
        }

        // Use URLRequest so we can set headers that browser WebSocket sends automatically.
        // URLSessionWebSocketTask(with: URL) sends no Origin, which many servers reject.
        var request = URLRequest(url: url)
        request.setValue("chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm", forHTTPHeaderField: "Origin")

        let task = session.webSocketTask(with: request)
        tasks[socketId] = task
        taskToSocketId[ObjectIdentifier(task)] = socketId
        task.resume()
    }

    func send(socketId: String, data: String) {
        guard let task = tasks[socketId] else { return }
        task.send(.string(data)) { [weak self] error in
            if let error = error {
                print("[WebSocketBridge] Send error for \(socketId): \(error.localizedDescription)")
                self?.fireEvent(socketId: socketId, event: "error", data: "null")
            }
        }
    }

    func close(socketId: String) {
        guard let task = tasks[socketId] else { return }
        task.cancel(with: .normalClosure, reason: nil)
        cleanup(socketId: socketId, task: task)
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        guard let socketId = taskToSocketId[ObjectIdentifier(webSocketTask)] else { return }
        print("[WebSocketBridge] Connected: \(socketId)")
        fireEvent(socketId: socketId, event: "open", data: "null")
        receiveLoop(socketId: socketId, task: webSocketTask)
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        guard let socketId = taskToSocketId[ObjectIdentifier(webSocketTask)] else { return }
        print("[WebSocketBridge] Closed: \(socketId) code=\(closeCode.rawValue)")
        fireEvent(socketId: socketId, event: "close", code: closeCode.rawValue, wasClean: true)
        cleanup(socketId: socketId, task: webSocketTask)
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        guard let wsTask = task as? URLSessionWebSocketTask,
              let socketId = taskToSocketId[ObjectIdentifier(wsTask)] else { return }
        if let error = error {
            // Don't fire events if we already cleaned up (e.g. normal close)
            guard tasks[socketId] != nil else { return }
            print("[WebSocketBridge] Error for \(socketId): \(error.localizedDescription)")
            fireEvent(socketId: socketId, event: "error", data: "null")
            fireEvent(socketId: socketId, event: "close", code: 1006, wasClean: false)
            cleanup(socketId: socketId, task: wsTask)
        }
    }

    // MARK: - Receive loop

    private func receiveLoop(socketId: String, task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self, self.tasks[socketId] != nil else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.fireMessageEvent(socketId: socketId, text: text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.fireMessageEvent(socketId: socketId, text: text)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop(socketId: socketId, task: task)

            case .failure(let error):
                guard self.tasks[socketId] != nil else { return }
                print("[WebSocketBridge] Receive error for \(socketId): \(error.localizedDescription)")
                self.fireEvent(socketId: socketId, event: "error", data: "null")
                self.fireEvent(socketId: socketId, event: "close", code: 1006, wasClean: false)
                self.cleanup(socketId: socketId, task: task)
            }
        }
    }

    // MARK: - JS event dispatch

    /// Fire a simple event (open, error).
    private func fireEvent(socketId: String, event: String, data: String) {
        let js = "window.__ff_wsEvent('\(socketId)', '\(event)', \(data));"
        evaluateInExtensionWorld(js)
    }

    /// Fire a close event with code and wasClean.
    private func fireEvent(socketId: String, event: String, code: Int, wasClean: Bool) {
        let js = "window.__ff_wsEvent('\(socketId)', 'close', { code: \(code), wasClean: \(wasClean) });"
        evaluateInExtensionWorld(js)
    }

    /// Fire a message event. Uses base64 to avoid escaping issues with arbitrary JSON.
    private func fireMessageEvent(socketId: String, text: String) {
        guard let b64 = text.data(using: .utf8)?.base64EncodedString() else { return }
        let js = "window.__ff_wsMessage('\(socketId)', '\(b64)');"
        evaluateInExtensionWorld(js)
    }

    private func evaluateInExtensionWorld(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, in: nil, in: FilteredWebView.extensionWorld) { _ in }
        }
    }

    // MARK: - Cleanup

    private func cleanup(socketId: String, task: URLSessionWebSocketTask) {
        taskToSocketId.removeValue(forKey: ObjectIdentifier(task))
        tasks.removeValue(forKey: socketId)
    }

    func disconnectAll() {
        for (socketId, task) in tasks {
            task.cancel(with: .normalClosure, reason: nil)
            taskToSocketId.removeValue(forKey: ObjectIdentifier(task))
            tasks.removeValue(forKey: socketId)
        }
    }
}
