//
//  TilesConfigurationIntent.swift
//  BouncerWidgets
//
//  What the user gets to decide about the row of tiles, expressed as an App
//  Intent so iOS can build the editor itself: long-press the widget, Edit
//  Widget, and these parameters appear as pickers.
//
//  THREE SLOTS RATHER THAN A COUNT AND A LIST
//
//  "How many" and "which ones" sound like two settings and are really one. A
//  count parameter would have to be kept in step with a list whose length it
//  claims to describe — and AppIntents has no way to show or hide a picker
//  based on another parameter's value, so a widget set to show two would still
//  offer a third platform picker underneath, doing nothing. Three slots, each
//  of which may be None, expresses both facts once: the widget shows as many
//  tiles as are filled.
//

import AppIntents
import WidgetKit

/// A slot on the row. `none` is a real case rather than an optional parameter:
/// AppIntents renders a non-optional enum as a plain picker with every case
/// listed, which is exactly the control wanted here — "None" reads as a
/// deliberate choice where an empty optional reads as unfinished setup.
enum WidgetSlot: String, AppEnum {
    case x
    case instagram
    case linkedin
    case none

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Platform")
    }

    static var caseDisplayRepresentations: [WidgetSlot: DisplayRepresentation] {
        [
            .x: DisplayRepresentation(title: "X"),
            .instagram: DisplayRepresentation(title: "Instagram"),
            .linkedin: DisplayRepresentation(title: "LinkedIn"),
            .none: DisplayRepresentation(title: "None"),
        ]
    }

    /// The tile this slot draws, or nil when the slot is empty.
    var tile: Tile? {
        switch self {
        case .x: return Tile(route: "twitter", mark: "X", name: "X")
        // Not a Bouncer platform on this branch — there is no Instagram entry
        // in platforms.config.json and no feed to open. The app answers this
        // route by opening the real Instagram app, which is where the gate's
        // shield is waiting. See SceneDelegate.openRealApp(for:).
        case .instagram: return Tile(route: "instagram", mark: "IG", name: "Instagram")
        case .linkedin: return Tile(route: "linkedin", mark: "in", name: "LinkedIn")
        case .none: return nil
        }
    }
}

/// One tile's worth of content. Not an AppEnum itself — it is what a slot
/// resolves to, and nothing in the editor picks one directly.
struct Tile: Hashable {
    let route: String
    let mark: String
    let name: String
}

struct TilesConfigurationIntent: WidgetConfigurationIntent {

    static var title: LocalizedStringResource { "Platforms" }

    static var description: IntentDescription {
        IntentDescription("Choose which platforms appear on the row, and how many. Set a slot to None to leave it out.")
    }

    @Parameter(title: "First", default: .x)
    var first: WidgetSlot

    @Parameter(title: "Second", default: .instagram)
    var second: WidgetSlot

    @Parameter(title: "Third", default: .linkedin)
    var third: WidgetSlot

    /// The row, left to right, with empty slots closed up rather than left as
    /// gaps — three tiles set to None, X, None should read as one tile, not as
    /// one tile marooned in the middle.
    var tiles: [Tile] {
        [first, second, third].compactMap(\.tile)
    }
}
