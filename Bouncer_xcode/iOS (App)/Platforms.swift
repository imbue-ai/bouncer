//
//  Platforms.swift
//  iOS (App)
//
//  Single source of truth for the platforms Bouncer supports on iOS. The
//  picker, the WebView's script/CSS injection, the URL-to-platform sync, and
//  the per-platform feed-URL switch all read from this list instead of
//  hardcoding the ids. Adding a new platform is one entry here (plus the
//  adapter implementation in Bouncer/adapters/<id>/).
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
    /// Order matters for the PlatformPickerView: rows render top-to-bottom in
    /// this order.
    static let all: [PlatformDef] = [
        PlatformDef(
            id: "twitter",
            displayName: "X",
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
        PlatformDef(
            id: "youtube",
            displayName: "YouTube",
            feedURL: "https://www.youtube.com/",
            loginURL: nil,
            adapterScriptName: "YouTubeAdapter",
            cssFile: "youtube",
            cssSubdir: "adapters/youtube",
            hostRoots: [
                "youtube.com", "m.youtube.com", "youtu.be",
                "ytimg.com", "ggpht.com", "googlevideo.com",
                "accounts.youtube.com",
            ]
        ),
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
    ]

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
