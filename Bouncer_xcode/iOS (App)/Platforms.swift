//
//  Platforms.swift
//  iOS (App)
//
//  Per-platform iOS data (feed URL, adapter/CSS names, host roots) lives in
//  `defined` below. WHICH of those platforms actually appear is gated by the
//  shared Bouncer/src/shared/platforms.config.json (its `targets` must include
//  "safari") — the single source of truth for platform enablement, shared with
//  the extension build. The picker, WebView script/CSS injection,
//  URL-to-platform sync, and feed-URL switch all read `Platforms.all`, which is
//  `defined` intersected with what the config enables.
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
    /// Per-platform iOS data, in PlatformPickerView row order (top to bottom).
    /// WHICH of these actually appear is gated by `enabledIds` — see `all`.
    private static let defined: [PlatformDef] = [
        PlatformDef(
            id: "twitter",
            displayName: "X (Twitter)",
            feedURL: "https://x.com/home",
            loginURL: "https://x.com/i/flow/login",
            adapterScriptName: "TwitterAdapter",
            cssFile: "twitter",
            cssSubdir: "adapters/twitter",
            hostRoots: [
                "x.com", "twitter.com", "t.co", "twimg.com",
                "pbs.twimg.com", "abs.twimg.com", "video.twimg.com",
            ]
        ),
// Millan todo: add back YT to ios
//         PlatformDef(
//             id: "youtube",
//             displayName: "YouTube",
//             feedURL: "https://www.youtube.com/",
//             loginURL: nil,
//             adapterScriptName: "YouTubeAdapter",
//             cssFile: "youtube",
//             cssSubdir: "adapters/youtube",
//             hostRoots: [
//                 "youtube.com", "m.youtube.com", "youtu.be",
//                 "ytimg.com", "ggpht.com", "googlevideo.com",
//                 "accounts.youtube.com",
//             ]
//         ),
        PlatformDef(
            id: "linkedin",
            displayName: "LinkedIn",
            feedURL: "https://www.linkedin.com/feed/",
            loginURL: nil,
            adapterScriptName: "LinkedInAdapter",
            cssFile: "linkedin",
            cssSubdir: "adapters/linkedin",
            hostRoots: [
                "linkedin.com", "licdn.com",
                "static.licdn.com", "media.licdn.com",
            ]
        ),
        PlatformDef(
            id: "instagram",
            displayName: "Instagram",
            // Bouncer's Instagram surface is the Reels viewer, not the home
            // feed — matches PLATFORM_RUNTIME.instagram.feedUrl on the JS side.
            feedURL: "https://www.instagram.com/reels/",
            loginURL: nil,
            adapterScriptName: "InstagramAdapter",
            cssFile: "instagram",
            cssSubdir: "adapters/instagram",
            hostRoots: [
                "instagram.com", "cdninstagram.com",
                "fbcdn.net", "facebook.com",
            ]
        ),
    ]

    /// Platforms actually shown on iOS: the entries `defined` above that are
    /// also enabled for the "safari" target in the shared
    /// platforms.config.json — the single source of truth for which platforms
    /// ship where. A platform missing from the config (or without "safari" in
    /// its targets) is dropped from the picker, WebView injection, and host
    /// guard, so the native UI can never offer a platform the JS pipeline
    /// doesn't know about.
    static let all: [PlatformDef] = defined.filter { enabledIds.contains($0.id) }

    /// Canonical ids enabled for this app's target ("safari"), read from the
    /// bundled platforms.config.json.
    private static let enabledIds: Set<String> = loadEnabledIds()

    private static func loadEnabledIds() -> Set<String> {
        guard let url = Bundle.main.url(
                forResource: "platforms.config", withExtension: "json", subdirectory: "shared"),
              let data = try? Data(contentsOf: url),
              let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            assertionFailure("platforms.config.json missing or invalid in app bundle")
            return []
        }
        var ids = Set<String>()
        for entry in entries {
            guard let id = entry["id"] as? String,
                  let targets = entry["targets"] as? [String],
                  targets.contains("safari") else { continue }
            ids.insert(id)
        }
        return ids
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
