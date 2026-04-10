//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Darren Jia on 2/12/26.
//

import UIKit
import SafariServices

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    private var statusRow: UIStackView?
    private var statusIconView: UIImageView?
    private var statusLabel: UILabel?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = makeRootViewController()
        window.makeKeyAndVisible()
        self.window = window

        checkExtensionStatus()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        checkExtensionStatus()
    }

    // MARK: - UI Setup

    private func makeRootViewController() -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1.0)

        let imageView = makeImageView()
        let titleLabel = makeLabel(text: "Bouncer", fontSize: 28, weight: .bold, color: .white)
        let subtitleLabel = makeLabel(text: "Tap below for setup instructions", fontSize: 17, weight: .regular, color: UIColor.white.withAlphaComponent(0.7))
        let statusRow = makeStatusRow()
        let button = makeButton(in: vc)

        let stackView = UIStackView(arrangedSubviews: [imageView, titleLabel, subtitleLabel, statusRow, button])
        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.spacing = 32
        stackView.translatesAutoresizingMaskIntoConstraints = false
        stackView.setCustomSpacing(12, after: titleLabel)
        stackView.setCustomSpacing(20, after: subtitleLabel)

        vc.view.addSubview(stackView)

        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 120),
            imageView.heightAnchor.constraint(equalToConstant: 120),
            button.widthAnchor.constraint(equalToConstant: 220),
            button.heightAnchor.constraint(equalToConstant: 48),
            stackView.centerYAnchor.constraint(equalTo: vc.view.centerYAnchor),
            stackView.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor, constant: 40),
            stackView.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -40),
        ])

        return vc
    }

    private func makeImageView() -> UIImageView {
        let config = UIImage.SymbolConfiguration(pointSize: 64, weight: .light)
        let imageView = UIImageView(image: UIImage(systemName: "checkmark.seal.fill", withConfiguration: config))
        imageView.contentMode = .scaleAspectFit
        imageView.tintColor = .white
        imageView.translatesAutoresizingMaskIntoConstraints = false
        return imageView
    }

    private func makeLabel(text: String, fontSize: CGFloat, weight: UIFont.Weight, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = UIFont.systemFont(ofSize: fontSize, weight: weight)
        label.textColor = color
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func makeStatusRow() -> UIStackView {
        let row = UIStackView()
        self.statusRow = row
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false

        let iconConfig = UIImage.SymbolConfiguration(pointSize: 22, weight: .medium)
        let icon = UIImageView(image: UIImage(systemName: "questionmark.circle.fill", withConfiguration: iconConfig))
        icon.tintColor = .systemGray
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setContentHuggingPriority(.required, for: .horizontal)
        self.statusIconView = icon

        let label = UILabel()
        label.text = "Extension status unknown"
        label.font = UIFont.systemFont(ofSize: 17, weight: .medium)
        label.textColor = .systemGray
        label.translatesAutoresizingMaskIntoConstraints = false
        self.statusLabel = label

        row.addArrangedSubview(icon)
        row.addArrangedSubview(label)
        return row
    }

    private func makeButton(in vc: UIViewController) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle("View Instructions", for: .normal)
        button.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        button.setTitleColor(.white, for: .normal)
        button.backgroundColor = vc.view.tintColor
        button.layer.cornerRadius = 12
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addAction(UIAction { _ in
            if let url = URL(string: "https://x.com/DarrenJiaImbue/status/2023919091611021772") {
                UIApplication.shared.open(url)
            }
        }, for: .touchUpInside)
        return button
    }

    // MARK: - Extension Status

    private func checkExtensionStatus() {
        if #available(iOS 26.2, *) {
            SFSafariExtensionManager.getStateOfExtension(withIdentifier: extensionBundleIdentifier) { state, error in
                print("[Bouncer] Extension state: \(state != nil ? "found" : "nil"), isEnabled: \(state?.isEnabled ?? false), error: \(error?.localizedDescription ?? "none")")
                DispatchQueue.main.async {
                    self.updateStatusUI(isEnabled: state?.isEnabled ?? false)
                }
            }
        } else {
            statusRow?.isHidden = true
        }
    }

    private func updateStatusUI(isEnabled: Bool) {
        let symbolName = isEnabled ? "checkmark.circle.fill" : "xmark.circle.fill"
        let color: UIColor = isEnabled ? .systemGreen : .systemRed
        let text = isEnabled ? "Extension enabled" : "Extension not enabled"
        let config = UIImage.SymbolConfiguration(pointSize: 22, weight: .medium)
        statusIconView?.image = UIImage(systemName: symbolName, withConfiguration: config)
        statusIconView?.tintColor = color
        statusLabel?.text = text
        statusLabel?.textColor = color
    }

}
