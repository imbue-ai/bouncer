//
//  PushPayload.swift
//  iOS (App) + NotificationService
//
//  The JSON x.com puts inside a Web Push message, and how to render it — a
//  port of the Android app's PushPayload.kt, which in turn mirrors the logic
//  of x.com's own service worker (https://x.com/sw.js):
//
//    { title: string, body?: string, tag?: string, icon?: string,
//      data?: { uri?, silent?, lang?, multi_title?, multi_body?, multi_uri?, … } }
//
//  The worker shows nothing for `silent`, and when a notification with the
//  same `tag` is still open it re-renders with the `multi_*` ICU templates
//  ("Alice and {num_others, plural, one {# other} other {# others}} liked…").
//  Foundation has no ICU MessageFormat, so `ICUMessage` below implements the
//  small subset those templates use.
//
//  Facebook's messages are a different shape, mapped onto the same fields by
//  `parseFacebook`. `PushSite` says which site a subscription belongs to.
//

import Foundation

/// The sites whose Web Push we turn on, and what differs between them. The
/// mechanism is the same for each (PushAutoEnabler clicks the site's own
/// toggle; pushes are decrypted and rendered natively). Mirrors Android's
/// PushSite.kt. LinkedIn isn't here: its web client has no Web Push at all.
enum PushSite: String, CaseIterable {
    case x
    case facebook

    /// Matches the Platforms id of the tab this site's feed lives in.
    var platformId: String {
        switch self {
        case .x: return "twitter"
        case .facebook: return "facebook"
        }
    }

    /// Service-worker scope the page subscribes under (the polyfill's default).
    var scope: String { origin + "/" }

    /// Origin taps resolve against (payload URIs never leave it).
    var origin: String {
        switch self {
        case .x: return "https://x.com"
        case .facebook: return "https://www.facebook.com"
        }
    }

    /// Shown when a push can't be decrypted or parsed.
    var fallbackTitle: String {
        switch self {
        case .x: return "X"
        case .facebook: return "Facebook"
        }
    }

    static let defaultURI = "/notifications"

    /// By host, so a worker registered under a sub-path scope still maps back.
    static func forScope(_ scope: String) -> PushSite? {
        guard let host = URL(string: scope)?.host?.lowercased() else { return nil }
        return allCases.first { URL(string: $0.origin)?.host == host }
    }
}

struct PushPayload {
    let title: String
    let body: String?
    let tag: String?
    let iconURL: String?
    let uri: String?
    let silent: Bool
    let lang: String?
    let multiTitle: String?
    let multiBody: String?
    let multiUri: String?

    struct Rendered {
        let title: String
        let body: String?
        let uri: String?
    }

    /// What the site's worker shows when a message doesn't parse.
    static func fallback(_ site: PushSite = .x) -> PushPayload {
        PushPayload(
            title: site.fallbackTitle, body: "New notification", tag: "default", iconURL: nil,
            uri: PushSite.defaultURI, silent: false, lang: nil, multiTitle: nil, multiBody: nil, multiUri: nil
        )
    }

    /// nil when the plaintext isn't the site's shape (caller shows `fallback`).
    static func parse(_ plaintext: Data?, site: PushSite = .x) -> PushPayload? {
        guard let plaintext, !plaintext.isEmpty,
              let obj = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any] else { return nil }
        if site == .facebook { return parseFacebook(obj) }
        guard let title = obj["title"] as? String else { return nil }
        let data = obj["data"] as? [String: Any]
        return PushPayload(
            title: title,
            body: obj["body"] as? String,
            tag: obj["tag"] as? String,
            iconURL: obj["icon"] as? String,
            uri: data?["uri"] as? String,
            silent: (data?["silent"] as? Bool) ?? false,
            lang: data?["lang"] as? String,
            multiTitle: data?["multi_title"] as? String,
            multiBody: data?["multi_body"] as? String,
            multiUri: data?["multi_uri"] as? String
        )
    }

    /// Text for the `count`-th notification shown under this tag (mirrors
    /// sw.js B()). The first one uses the plain fields; later ones swap in
    /// the multi_* templates. A template that fails to format falls back to
    /// the plain field.
    func render(count: Int) -> Rendered {
        guard count > 1 else { return Rendered(title: title, body: body, uri: uri) }
        let args = ["num_others": count - 1, "num_total": count]
        return Rendered(
            title: multiTitle.flatMap { ICUMessage.format($0, args: args) } ?? title,
            body: multiBody.flatMap { ICUMessage.format($0, args: args) } ?? body,
            uri: multiUri ?? uri
        )
    }

    /// Facebook's worker (ServiceWorkerPushEvent in its /sw?s=push bundle)
    /// renders a message inline only when it carries a `type`:
    ///
    ///   { type, title?, message?, href?, ppu? | pic?, i? | t? (notif id),
    ///     params?: { t_n? }, … }
    ///
    /// Anything else is a content-less "tickle" its worker resolves with a
    /// cookie-authenticated fetch, which the extension can't make — so those
    /// get the fallback, as its worker does when that fetch fails. Each
    /// notification id is its own tag, so pushes stack rather than replace.
    private static func parseFacebook(_ obj: [String: Any]) -> PushPayload? {
        guard obj["type"] is String else { return nil }
        let params = obj["params"] as? [String: Any]
        let title = (obj["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (params?["t_n"] as? String)
            ?? PushSite.facebook.fallbackTitle
        let id = [obj["i"], obj["t"]].compactMap { $0 }.first { !($0 is NSNull) }.map { "\($0)" }
        return PushPayload(
            title: title,
            body: obj["message"] as? String,
            tag: id.map { "fb_" + $0 },
            iconURL: (obj["ppu"] as? String) ?? (obj["pic"] as? String),
            uri: obj["href"] as? String,
            silent: false, lang: nil, multiTitle: nil, multiBody: nil, multiUri: nil
        )
    }

    /// The page a tap opens. Mirrors sw.js W(): resolve `uri` against the
    /// site's origin and keep only path + query, so a payload can never steer
    /// the tap off-origin, and an unparseable one lands on /notifications.
    static func resolveClickURL(_ uri: String?, site: PushSite = .x) -> URL {
        let origin = site.origin
        let defaultURI = PushSite.defaultURI
        let fallbackURL = URL(string: origin + defaultURI)!
        let target = uri?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !target.isEmpty,
              let base = URL(string: origin + "/"),
              let resolved = URL(string: target, relativeTo: base)?.absoluteURL,
              let comps = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              comps.scheme == "http" || comps.scheme == "https" else {
            // Opaque / unparseable → somewhere harmless, like sw.js.
            if target.isEmpty { return fallbackURL }
            return URL(string: origin + "/")!
        }
        var out = URLComponents(string: origin)!
        out.percentEncodedPath = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
        out.percentEncodedQuery = comps.percentEncodedQuery
        return out.url ?? fallbackURL
    }
}

/// The subset of ICU MessageFormat x.com's multi_* templates use: literal
/// text, `{name}` arguments, `{name, plural, [offset:n] =k {…} one {…}
/// other {…}}` with `#` for the (offset-adjusted) number. Category selection
/// is the English rule (one / other) plus exact `=k` matches, which covers
/// every template x.com ships; anything unparseable returns nil so the
/// caller falls back to the plain title/body.
enum ICUMessage {
    static func format(_ template: String, args: [String: Int]) -> String? {
        var parser = Parser(Array(template), args: args)
        guard let out = parser.parseMessage(pound: nil), parser.atEnd else { return nil }
        return out
    }

    private struct Parser {
        let chars: [Character]
        let args: [String: Int]
        var pos = 0

        init(_ chars: [Character], args: [String: Int]) {
            self.chars = chars
            self.args = args
        }

        var atEnd: Bool { pos >= chars.count }

        // Parses until an unmatched '}' or end of input.
        mutating func parseMessage(pound: Int?) -> String? {
            var out = ""
            while pos < chars.count {
                let c = chars[pos]
                if c == "}" { return out }
                if c == "#", let n = pound {
                    out += String(n)
                    pos += 1
                    continue
                }
                if c == "'" {
                    // ICU quoting: '' is a literal apostrophe; '{...}' quotes braces.
                    if pos + 1 < chars.count, chars[pos + 1] == "'" {
                        out.append("'"); pos += 2; continue
                    }
                    if pos + 1 < chars.count, chars[pos + 1] == "{" || chars[pos + 1] == "}" || chars[pos + 1] == "#" {
                        pos += 1
                        while pos < chars.count, chars[pos] != "'" { out.append(chars[pos]); pos += 1 }
                        pos += 1
                        continue
                    }
                    out.append("'"); pos += 1; continue
                }
                if c == "{" {
                    pos += 1
                    guard let s = parseArgument() else { return nil }
                    out += s
                    continue
                }
                out.append(c)
                pos += 1
            }
            return out
        }

        // Called just after '{'. Consumes through the matching '}'.
        mutating func parseArgument() -> String? {
            let name = readUntil { $0 == "," || $0 == "}" }.trimmingCharacters(in: .whitespaces)
            guard pos < chars.count else { return nil }
            if chars[pos] == "}" {
                pos += 1
                guard let v = args[name] else { return nil }
                return String(v)
            }
            pos += 1 // ','
            let type = readUntil { $0 == "," || $0 == "}" }.trimmingCharacters(in: .whitespaces)
            guard type == "plural", pos < chars.count, chars[pos] == "," else { return nil }
            pos += 1
            guard let value = args[name] else { return nil }
            var offset = 0
            var options: [(String, Int)] = [] // (selector, start index of its message)
            var chosen: String?
            skipWhitespace()
            while pos < chars.count, chars[pos] != "}" {
                let selector = readUntil { $0 == "{" || $0.isWhitespace }.trimmingCharacters(in: .whitespaces)
                skipWhitespace()
                if selector.hasPrefix("offset:") {
                    offset = Int(selector.dropFirst("offset:".count)) ?? 0
                    continue
                }
                guard pos < chars.count, chars[pos] == "{" else { return nil }
                pos += 1
                options.append((selector, pos))
                guard skipMessage() else { return nil }
                skipWhitespace()
            }
            guard pos < chars.count else { return nil }
            pos += 1 // closing '}' of the plural
            let n = value - offset
            let category = (n == 1) ? "one" : "other"
            for (sel, _) in options where sel == "=\(value)" { chosen = sel }
            if chosen == nil, options.contains(where: { $0.0 == category }) { chosen = category }
            if chosen == nil, options.contains(where: { $0.0 == "other" }) { chosen = "other" }
            guard let sel = chosen, let start = options.first(where: { $0.0 == sel })?.1 else { return nil }
            // Re-parse the chosen option's message with '#' bound to n.
            let save = pos
            pos = start
            let rendered = parseMessage(pound: n)
            pos = save
            return rendered
        }

        // Skips a balanced message body starting just after '{', leaving pos after its '}'.
        mutating func skipMessage() -> Bool {
            var depth = 1
            while pos < chars.count {
                let c = chars[pos]
                if c == "'" , pos + 1 < chars.count, chars[pos + 1] == "'" { pos += 2; continue }
                if c == "{" { depth += 1 }
                if c == "}" { depth -= 1; if depth == 0 { pos += 1; return true } }
                pos += 1
            }
            return false
        }

        mutating func readUntil(_ stop: (Character) -> Bool) -> String {
            var s = ""
            while pos < chars.count, !stop(chars[pos]) { s.append(chars[pos]); pos += 1 }
            return s
        }

        mutating func skipWhitespace() {
            while pos < chars.count, chars[pos].isWhitespace { pos += 1 }
        }
    }
}
