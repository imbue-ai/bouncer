//
//  Platforms.swift
//  iOS (App)
//
//  The list of platforms Bouncer supports on iOS is NOT defined here — it is
//  decoded from the shared, single source of truth
//  `Bouncer/src/shared/platforms.config.json`, which ships in the app bundle
//  (the `shared` folder reference). The picker, the WebView's script/CSS
//  injection, the URL-to-platform sync, and the per-platform feed-URL switch
//  all read `Platforms.all`, which is exactly the config entries whose
//  `targets` include this app's target ("safari").
//
//  Consequence: a platform is present in the iOS UI if and only if it appears
//  in platforms.config.json for the safari target. Removing it there (or
//  dropping "safari" from its targets) removes it from every part of the app
//  — no picker row, no adapter injection, no host-guard entry. Adding one is a
//  single edit in the JSON (plus the adapter implementation under
//  Bouncer/adapters/<id>/). There is no second list to keep in sync.
//

import Foundation

struct PlatformDef {
    /// Canonical id — matches the SiteId values used on the JS side
    /// ("twitter", "youtube", "linkedin"). Stored as String so the existing
    /// FilterSheetViewModel.selectedPlatform: String contract is unchanged.
    let id: String

    /// Human-facing label used in PlatformPickerView's rows.
    let displayName: String

    /// Initial URL the WebView loads when the user picks this platform.
    /// For X this is the home feed if signed in, falling back to the login
    /// flow on first launch — see `loginURL`.
    let feedURL: String

    /// First-launch URL when the user has never signed in. nil for platforms
    /// that handle authentication internally without needing a special entry
    /// point (YouTube, LinkedIn).
    let loginURL: String?

    /// Bundled-resource filename (without .js extension) for this platform's
    /// adapter script in dist/. FilteredWebView injects each adapter as a
    /// WKUserScript at document-end; the adapter self-guards by hostname.
    let adapterScriptName: String

    /// Filename (without .css extension) of the platform's stylesheet.
    let cssFile: String

    /// Bundle subdirectory holding `cssFile`. Matches the desktop manifest's
    /// content_scripts.css paths under adapters/<id>/.
    let cssSubdir: String

    /// True when this platform owns `host` — covers root + subdomain matches.
    /// Used by syncPlatformToCurrentSite() to map the WebView's current host
    /// back to a platform id.
    func matches(host: String) -> Bool {
        let h = host.lowercased()
        return hostRoots.contains { root in h == root || h.hasSuffix("." + root) }
    }

    /// Domains this platform considers part of itself, including any related
    /// CDN / API hosts that should be permitted by `allowedHosts` in
    /// FilteredWebView's navigation guard. Stored as raw domains; the
    /// WebView allowedHosts list flat-maps these from every PlatformDef.
    let hostRoots: [String]
}

enum Platforms {
    /// This app's build target, matching build.js `--target=` and the
    /// `targets` values in platforms.config.json. Both the iOS and macOS
    /// apps build with `--target=safari`.
    private static let currentTarget = "safari"

    /// Raw JSON shape of one entry in platforms.config.json. Only the fields
    /// the iOS app needs are decoded; extras (manifestHost,
    /// extraWebAccessible, …) are ignored.
    private struct ConfigEntry: Decodable {
        let id: String
        let displayName: String
        let targets: [String]
        let adapterScript: String
        let cssPath: String
        let feedUrl: String
        let loginUrl: String?
        let hostRoots: [String]
    }

    /// Platforms shipped on this build, in config order (which drives the
    /// PlatformPickerView row order). Decoded once from the bundled config.
    static let all: [PlatformDef] = loadFromConfig()

    private static func loadFromConfig() -> [PlatformDef] {
        guard let url = Bundle.main.url(
            forResource: "platforms.config", withExtension: "json", subdirectory: "shared"
        ) else {
            assertionFailure("platforms.config.json missing from app bundle (shared/)")
            return []
        }
        do {
            let data = try Data(contentsOf: url)
            let entries = try JSONDecoder().decode([ConfigEntry].self, from: data)
            return entries
                .filter { $0.targets.contains(currentTarget) }
                .map(makePlatformDef)
        } catch {
            assertionFailure("Failed to decode platforms.config.json: \(error)")
            return []
        }
    }

    /// Map a JSON entry to the runtime PlatformDef, deriving the bundled
    /// resource names from the shared asset paths so the config stays the
    /// single source (adapterScript "dist/TwitterAdapter.js" -> script name
    /// "TwitterAdapter"; cssPath "adapters/twitter/twitter.css" -> subdir
    /// "adapters/twitter", file "twitter").
    private static func makePlatformDef(_ e: ConfigEntry) -> PlatformDef {
        let adapterScriptName = (e.adapterScript as NSString)
            .lastPathComponent
        let scriptName = (adapterScriptName as NSString).deletingPathExtension
        let cssSubdir = (e.cssPath as NSString).deletingLastPathComponent
        let cssFile = ((e.cssPath as NSString).lastPathComponent as NSString)
            .deletingPathExtension
        return PlatformDef(
            id: e.id,
            displayName: e.displayName,
            feedURL: e.feedUrl,
            loginURL: e.loginUrl,
            adapterScriptName: scriptName,
            cssFile: cssFile,
            cssSubdir: cssSubdir,
            hostRoots: e.hostRoots
        )
    }

    /// Lookup by canonical id (e.g., "twitter"). Returns nil for unknown ids.
    static func byId(_ id: String) -> PlatformDef? {
        return all.first { $0.id == id }
    }

    /// Lookup by host — finds which platform "owns" a URL. Useful for the
    /// syncPlatformToCurrentSite() flow that maps a WebView URL change back
    /// to the matching platform id.
    static func fromHost(_ host: String) -> PlatformDef? {
        return all.first { $0.matches(host: host) }
    }

    /// Flat list of every host any platform considers its own — used by the
    /// WebView navigation guard's allowedHosts. Auth / system hosts
    /// (Google sign-in, Apple ID, etc.) are added on top of this in
    /// FilteredWebView since they're shared across platforms.
    static var allHostRoots: [String] {
        return all.flatMap { $0.hostRoots }
    }
}
