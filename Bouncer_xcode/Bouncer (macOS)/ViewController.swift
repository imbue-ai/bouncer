//
//  ViewController.swift
//  Bouncer (macOS)
//
//  Created by Darren Jia on 4/16/26.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = Bundle.main.bundleIdentifier! + ".Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        let htmlURL = Bundle.main.url(forResource: "Main", withExtension: "html")!
        let resourceDir = htmlURL.deletingLastPathComponent().deletingLastPathComponent()
        self.webView.loadFileURL(htmlURL, allowingReadAccessTo: resourceDir)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[Bouncer Mac] Checking extension state for: \(extensionBundleIdentifier)")
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            if let error = error {
                print("[Bouncer Mac] Error getting extension state: \(error)")
                DispatchQueue.main.async {
                    webView.evaluateJavaScript("show(undefined, true)")
                }
                return
            }
            guard let state = state else {
                print("[Bouncer Mac] Extension state is nil")
                return
            }

            print("[Bouncer Mac] Extension enabled: \(state.isEnabled)")
            DispatchQueue.main.async {
                let js = "show(\(state.isEnabled), true)"
                print("[Bouncer Mac] Evaluating JS: \(js)")
                webView.evaluateJavaScript(js) { result, error in
                    if let error = error {
                        print("[Bouncer Mac] JS evaluation error: \(error)")
                    } else {
                        print("[Bouncer Mac] JS evaluation succeeded: \(String(describing: result))")
                    }
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as! String != "open-preferences") {
            return;
        }

        print("[Bouncer Mac] Opening Safari extension preferences...")
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            if let error = error {
                print("[Bouncer Mac] Error opening preferences: \(error)")
            }
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

}
