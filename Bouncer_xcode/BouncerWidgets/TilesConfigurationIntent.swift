//
//  TilesConfigurationIntent.swift
//  BouncerWidgets
//
//  What the user gets to decide about the row of tiles, expressed as an App
//  Intent so iOS can build the editor itself: long-press the widget, Edit
//  Widget, and these parameters appear as pickers.
//
//  SLOTS RATHER THAN A COUNT AND A LIST
//
//  "How many" and "which ones" sound like two settings and are really one. A
//  count parameter would have to be kept in step with a list whose length it
//  claims to describe — and AppIntents has no way to show or hide a picker
//  based on another parameter's value, so a widget set to show one would still
//  offer a second platform picker underneath, doing nothing. A slot per
//  possible tile, each of which may be None, expresses both facts once: the
//  widget shows as many tiles as are filled.
//
//  There are two slots because there are two platforms. Instagram is not one
//  of them yet — Bouncer has no Instagram feed on this branch, so offering it
//  here would be offering a tile that opens somebody else's app. When it
//  ships, it is a case and a slot.
//

import AppIntents
import WidgetKit

/// A slot on the row. `none` is a real case rather than an optional parameter:
/// AppIntents renders a non-optional enum as a plain picker with every case
/// listed, which is exactly the control wanted here — "None" reads as a
/// deliberate choice where an empty optional reads as unfinished setup.
enum WidgetSlot: String, AppEnum {
    case x
    case linkedin
    case none

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Platform")
    }

    static var caseDisplayRepresentations: [WidgetSlot: DisplayRepresentation] {
        [
            .x: DisplayRepresentation(title: "X"),
            .linkedin: DisplayRepresentation(title: "LinkedIn"),
            .none: DisplayRepresentation(title: "None"),
        ]
    }

    /// The tile this slot draws, or nil when the slot is empty.
    var tile: Tile? {
        switch self {
        case .x: return Tile(route: "twitter", mark: "X", name: "X")
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

    @Parameter(title: "Second", default: .linkedin)
    var second: WidgetSlot

    /// The row, left to right, with empty slots closed up rather than left as
    /// gaps — None then X should read as one tile at the left, not as one tile
    /// pushed to the right of a hole.
    var tiles: [Tile] {
        [first, second].compactMap(\.tile)
    }
}
