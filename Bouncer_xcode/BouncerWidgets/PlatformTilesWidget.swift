//
//  PlatformTilesWidget.swift
//  BouncerWidgets
//
//  A row of tiles — X and LinkedIn — meant to sit on the home screen where
//  those apps' own icons would be.
//
//  WHY A WIDGET AND NOT A SHORTCUT
//
//  The gate (see ScreenTime/Shared/Gate.swift) puts a door in front of the real
//  apps, and the door's better answer is "view it in Bouncer". But nothing on
//  the home screen offers that as a FIRST move — the only Bouncer-shaped thing
//  there is the Bouncer icon, which lands on the platform picker and asks a
//  question the person has usually already answered by tapping. This row is the
//  short way in: one tap, straight to that platform's feed, filtered.
//
//  MEDIUM ONLY, DELIBERATELY
//
//  A small widget has exactly one tap target — the system routes the whole
//  thing through `widgetURL` and ignores `Link` — so several destinations
//  cannot be expressed in one. Rather than ship a small variant where most of
//  the tiles quietly open the wrong feed, the widget offers the family that can
//  actually do what it looks like it does.
//
//  THE TILES ARE BOUNCER'S, NOT THE PLATFORMS'
//
//  Drawn in Bouncer's own palette with a plain wordmark rather than as replicas
//  of the real app icons. Reproducing another company's mark is a trademark
//  problem and an App Review one, and the row still reads as what it is.
//

import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Colours
//
// The pair the user chose for the shield, read from the App Group. The widget
// and the shield are the same feature seen from two places, and a home-screen
// row still in last month's colour would read as a bug rather than a default.
//
// Read per timeline rather than held in a `static let`: a widget process is
// short-lived and re-entered, and the app asks WidgetKit for a reload when the
// tint changes — see GateSetupSections.

// Properties on the tint rather than free functions, and not only for
// tidiness: a free `accentColor(_:)` is shadowed inside any view body by
// SwiftUI's own `View.accentColor(_:)` modifier, which resolves first and
// fails with an error about ShapeStyle that names neither.
//
// Same shape as the app-side extension in ShieldTintPicker.swift; duplicated
// because an extension cannot see the app's source, and the app cannot see
// this one.
private extension Gate.ShieldTint {
    var accentColor: Color {
        Color(red: accent.red, green: accent.green, blue: accent.blue)
    }

    var inkColor: Color {
        Color(red: ink.red, green: ink.green, blue: ink.blue)
    }
}

// MARK: - Timeline
//
// Nothing on the tiles depends on time, so there is one entry and a `.never`
// refresh policy. What the tiles DO depend on — which platforms, and which
// colour — changes only by an explicit act: reconfiguring the widget, which
// WidgetKit reloads for us, or choosing a new tint in Bouncer, which asks for
// a reload itself.

private struct Entry: TimelineEntry {
    let date: Date
    let tiles: [Tile]
    let tint: Gate.ShieldTint
}

private struct Provider: AppIntentTimelineProvider {

    func placeholder(in context: Context) -> Entry {
        Entry(date: Date(), tiles: Self.defaultTiles, tint: .blush)
    }

    func snapshot(for configuration: TilesConfigurationIntent,
                  in context: Context) async -> Entry {
        entry(for: configuration)
    }

    func timeline(for configuration: TilesConfigurationIntent,
                  in context: Context) async -> Timeline<Entry> {
        Timeline(entries: [entry(for: configuration)], policy: .never)
    }

    /// A row emptied down to nothing looks broken rather than configured, so an
    /// all-None configuration falls back to the default set.
    private func entry(for configuration: TilesConfigurationIntent) -> Entry {
        let tiles = configuration.tiles
        return Entry(date: Date(),
                     tiles: tiles.isEmpty ? Self.defaultTiles : tiles,
                     tint: Gate.shieldTint)
    }

    private static let defaultTiles: [Tile] =
        [WidgetSlot.x, .linkedin].compactMap(\.tile)
}

// MARK: - The widget

struct PlatformTilesWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "BouncerPlatformTiles",
            intent: TilesConfigurationIntent.self,
            provider: Provider()
        ) { entry in
            PlatformTilesView(entry: entry)
                // Required from iOS 17 on: without it the widget draws on
                // whatever the system decides, and the ink the tiles are
                // designed against is not it.
                .containerBackground(entry.tint.inkColor, for: .widget)
        }
        .configurationDisplayName("Your Platforms")
        .description("Opens your platforms within Bouncer. Long-press the widget to configure.")
        .supportedFamilies([.systemMedium])
    }
}

private struct PlatformTilesView: View {
    let entry: Entry

    var body: some View {
        HStack(spacing: 0) {
            ForEach(entry.tiles, id: \.self) { tile in
                // One `Link` per tile is what makes this several destinations
                // rather than one. Medium widgets support that; small ones do
                // not, which is why this widget is medium-only.
                Link(destination: URL(string: "bouncer://platform/\(tile.route)")!) {
                    TileView(tile: tile, tint: entry.tint)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct TileView: View {
    let tile: Tile
    let tint: Gate.ShieldTint

    var body: some View {
        VStack(spacing: 7) {
            // 58pt, which is what a home-screen icon actually measures on a
            // 6.1" phone (60pt, less a little so the row does not crowd the
            // widget's own edges). The row is supposed to read as the thing it
            // is standing in for, and size is most of that.
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(tint.accentColor)
                .frame(width: 58, height: 58)
                .overlay {
                    Text(tile.mark)
                        // Rounded rather than the system default: the mark sits
                        // inside a squircle, and a rounded face agrees with the
                        // shape it is centred in.
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(tint.inkColor)
                        // Marks are short today, but a longer one should
                        // shrink rather than force every mark down to the size
                        // of the worst case.
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }

            Text(tile.name)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(tint.accentColor)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        // The label is the destination, not decoration — VoiceOver should say
        // where the tap goes, not read the tile as two separate texts.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Open \(tile.name) in Bouncer")
    }
}
