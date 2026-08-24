//
//  PlatformTilesWidget.swift
//  BouncerWidgets
//
//  A row of three tiles — X, Instagram, LinkedIn — meant to sit on the home
//  screen where those apps' own icons would be.
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
//  thing through `widgetURL` and ignores `Link` — so three destinations cannot
//  be expressed in one. Rather than ship a small variant where two of the three
//  tiles quietly open the wrong feed, the widget offers the family that can
//  actually do what it looks like it does.
//
//  THE TILES ARE BOUNCER'S, NOT THE PLATFORMS'
//
//  Drawn in Bouncer's own palette with a plain wordmark rather than as replicas
//  of the real app icons. Reproducing another company's mark is a trademark
//  problem and an App Review one, and the row still reads as what it is.
//

import SwiftUI
import WidgetKit

// MARK: - What is on the row

/// One tile. `route` is the id the app is asked to open — a Bouncer platform id
/// where one exists, and otherwise a name the app knows how to hand off.
private struct Tile {
    let route: String
    let mark: String
    let name: String
}

private let tiles: [Tile] = [
    Tile(route: "twitter", mark: "X", name: "X"),
    // Not a Bouncer platform on this branch — there is no Instagram entry in
    // platforms.config.json and no feed to open. The app answers this route by
    // opening the real Instagram app instead, which is where the gate's shield
    // is waiting. See SceneDelegate.openRealApp(for:).
    Tile(route: "instagram", mark: "IG", name: "Instagram"),
    Tile(route: "linkedin", mark: "in", name: "LinkedIn"),
]

// MARK: - Colours
//
// Bouncer's two, sampled from the app icon: #E09898 and #482020. Duplicated
// from ShieldConfigurationExtension rather than shared because an extension
// cannot read the app's bundle and these are the only two values involved —
// a shared file for six numbers would cost more than it saves. If they change,
// they change in both places.

private let salmon = Color(red: 0.878, green: 0.596, blue: 0.596)
private let ink = Color(red: 0.282, green: 0.125, blue: 0.125)

// MARK: - Timeline
//
// Static, and static forever. Nothing on the tiles depends on time, on the
// gate's state, or on anything stored — so there is one entry, with a distant
// refresh policy, and WidgetKit is never asked to wake us up again.

private struct Entry: TimelineEntry {
    let date: Date
}

private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: Date())], policy: .never))
    }
}

// MARK: - The view

struct PlatformTilesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BouncerPlatformTiles", provider: Provider()) { _ in
            PlatformTilesView()
                // Required from iOS 17 on: without it the widget draws on
                // whatever the system decides, and the ink the tiles are
                // designed against is not it.
                .containerBackground(ink, for: .widget)
        }
        .configurationDisplayName("Your feeds")
        .description("X, Instagram and LinkedIn — opened in Bouncer, filtered.")
        .supportedFamilies([.systemMedium])
    }
}

private struct PlatformTilesView: View {
    var body: some View {
        HStack(spacing: 0) {
            ForEach(tiles, id: \.route) { tile in
                // One `Link` per tile is what makes this three destinations
                // rather than one. Medium widgets support that; small ones do
                // not, which is why this widget is medium-only.
                Link(destination: URL(string: "bouncer://platform/\(tile.route)")!) {
                    TileView(tile: tile)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct TileView: View {
    let tile: Tile

    var body: some View {
        VStack(spacing: 7) {
            // 58pt, which is what a home-screen icon actually measures on a
            // 6.1" phone (60pt, less a little so the row does not crowd the
            // widget's own edges). The row is supposed to read as the thing it
            // is standing in for, and size is most of that.
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(salmon)
                .frame(width: 58, height: 58)
                .overlay {
                    Text(tile.mark)
                        // Rounded rather than the system default: the mark sits
                        // inside a squircle, and a rounded face agrees with the
                        // shape it is centred in.
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(ink)
                        // "Instagram" is two letters where the others are one
                        // and a bit; let the wide one shrink rather than making
                        // every mark small enough for the worst case.
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }

            Text(tile.name)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(salmon)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        // The label is the destination, not decoration — VoiceOver should say
        // where the tap goes, not read the tile as two separate texts.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Open \(tile.name) in Bouncer")
    }
}
