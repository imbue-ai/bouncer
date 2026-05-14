//
//  SafariWebExtensionHandler.swift
//  Bouncer (macOS) Extension
//
//  Handles native messages from the extension's background script.
//  Routes Sign in with Apple through the host app since the extension
//  process has no window for ASAuthorizationController.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: [String: Any]?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        } else {
            message = request?.userInfo?["message"] as? [String: Any]
        }

        os_log(.default, "[Bouncer Native] Received message: %@", String(describing: message))

        guard let type = message?["type"] as? String else {
            sendResponse(context: context, data: ["error": "missing type"])
            return
        }

        switch type {
        case "signInWithApple":
            // The extension handler runs in a headless process with no windows.
            // ASAuthorizationController needs a window to present its UI.
            // We need to open the host app to handle the sign-in.
            os_log(.default, "[Bouncer Native] signInWithApple requested — opening host app")

            // Use NSWorkspace to launch the host app with a flag
            let bundleId = Bundle.main.bundleIdentifier?
                .replacingOccurrences(of: ".Extension", with: "") ?? ""
            os_log(.default, "[Bouncer Native] Host app bundle ID: %@", bundleId)

            // Store the context for later response
            // For now, respond with an instruction to open the host app
            sendResponse(context: context, data: [
                "action": "openHostApp",
                "hostBundleId": bundleId,
                "message": "Please open the Bouncer app to complete sign-in"
            ])

        default:
            sendResponse(context: context, data: ["echo": message as Any])
        }
    }

    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: data]
        } else {
            response.userInfo = ["message": data]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
