//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Darren Jia on 2/12/26.
//

import UIKit
import TipKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppCheckBridge.shared.configure()
        try? Tips.configure([.displayFrequency(.immediate)])
        // Touch the downloader singleton at launch so its background
        // URLSession is bound to the delegate before iOS tries to
        // deliver any pending events for our session identifier.
        _ = ModelDownloader.shared
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    // iOS calls this when relaunching the app to deliver background
    // URLSession events (download finished, error, etc.) for a session
    // whose `sessionSendsLaunchEvents` is true. We stash the system
    // completion handler on the downloader; it's invoked once
    // urlSessionDidFinishEvents fires.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == ModelDownloader.sessionIdentifier else {
            completionHandler()
            return
        }
        ModelDownloader.shared.backgroundEventsCompletionHandler = completionHandler
    }
}
