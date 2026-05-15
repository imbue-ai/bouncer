//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Darren Jia on 2/12/26.
//

import UIKit
import SwiftUI

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: FilteredWebViewContainer())
        window.makeKeyAndVisible()
        self.window = window
    }
}
