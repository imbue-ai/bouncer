//
//  ShieldConfigurationExtension.swift
//  BouncerShieldConfiguration
//
//  The screen between tapping X and X.
//
//  It is worth being clear about what this extension is and is not. It is not a
//  view controller — there is no layout, no SwiftUI, no place to put a third
//  option or an explanation. iOS renders the shield itself and asks us only for
//  content: an icon, a title, a subtitle, and up to two buttons. That
//  constraint is the design brief. The fork has to be answerable in two words,
//  by someone who is not reading.
//
//  Which is a good discipline for this particular fork, because the honest
//  version of it is a question about intent, and questions about intent get
//  worse the longer they are:
//
//      "View in X"  — the real app, as usual.
//      "View in Bouncer"    — the same content, in a viewer whose terms are
//                             yours.
//
//  Named after destinations rather than intentions. Earlier drafts said
//  "Friends" and "Feed", which described WHY you might be here — and required
//  the reader to already know that Friends meant X and Feed meant
//  Bouncer. Two words that both need a footnote are worse than four that need
//  none, on a screen nobody reads twice.
//
//  Note what is NOT here: a "just this once" or a "5 more minutes". Those are
//  the buttons that make a gate decorative. The way through is either a person
//  or a decision, and both of them lead somewhere specific.
//

import ManagedSettings
import ManagedSettingsUI
import UIKit

class ShieldConfigurationExtension: ShieldConfigurationDataSource {

    /// The pair the shield draws itself in, read fresh on every render.
    ///
    /// The shield is the first Bouncer surface anyone sees in a day and it
    /// should not look like a system error — a door in the app's own colour
    /// reads as somewhere to go, where grey-on-black reads as something gone
    /// wrong. Which colour that is, the user picks during onboarding; the
    /// default is the pair sampled from the app icon, #E09898 on #482020.
    ///
    /// Read rather than cached in a `static let` because a static initialises
    /// once per process and this process is relaunched for every shield: the
    /// cost of reading is one UserDefaults hit, and the reward is that changing
    /// the colour in Bouncer shows up on the next shield instead of the next
    /// install. See Gate.ShieldTint for why it is a pair and not one colour.
    private static var tint: Gate.ShieldTint { Gate.shieldTint }

    private static var accent: UIColor { color(tint.accent) }
    private static var ink: UIColor { color(tint.ink) }

    private static func color(_ c: (red: Double, green: Double, blue: Double)) -> UIColor {
        UIColor(red: c.red, green: c.green, blue: c.blue, alpha: 1.0)
    }

    /// The glyph above the title, or nothing.
    ///
    /// Nothing, by default. There was an SF Symbol here — a raised hand — and it
    /// was doing the opposite of the job: a stop sign on a door whose whole
    /// argument is that it is not a wall. An unillustrated shield reads as a
    /// question, which is what this is.
    ///
    /// `GateShieldIcon` is still honoured if it exists, and is looked up in THIS
    /// bundle rather than the app's — an extension is its own bundle and cannot
    /// The Bouncer mark, from this extension's own asset catalog.
    ///
    /// Its own, and that is the whole trick: an extension cannot read the app's
    /// bundle, so an image living in the app's catalog is not findable from
    /// here however it is named. With nothing to find, iOS drew its own default
    /// — the blue hourglass everybody recognises as Screen Time, which is
    /// exactly the wrong association for a door Bouncer put there.
    ///
    /// Template-rendered so it takes the ink colour and sits with the type
    /// rather than beside it as a second, differently-coloured thing.
    private static func icon() -> UIImage? {
        UIImage(named: "GateShieldIcon")?.withRenderingMode(.alwaysTemplate)
            .withTintColor(Self.accent, renderingMode: .alwaysOriginal)
    }

    /// The name to greet, or nil when there isn't one.
    ///
    /// Read fresh on every render rather than baked in: the extension is
    /// relaunched for each shield, so whatever the app last wrote into the App
    /// Group is what appears. Change the name in Bouncer and the next shield
    /// says the new one — no rebuild, no reinstall.
    private static var greetedName: String? {
        guard let name = Gate.displayName, !name.isEmpty else { return nil }
        return name
    }

    /// The whole of what the shield says.
    ///
    /// One sentence, in the title slot, and nothing in the subtitle. There are
    /// exactly two text slots and iOS draws the title larger — so the way to
    /// make the greeting big is to make it the only thing there. Everything
    /// that used to sit underneath it (what each button does, what the viewer
    /// is for) was explaining buttons that already say where they go.
    ///
    /// The line break is doing real work: the name lands on its own line and
    /// the question follows, which reads as one sentence in two beats rather
    /// than a wall of greeting.
    private static func titleText() -> String {
        guard let name = greetedName else { return "What are you here for?" }
        return "Hey \(name),\nwhat are you here for?"
    }

    /// The shield, for an app Bouncer may or may not have a feed for.
    ///
    /// `appName` is `Application.localizedDisplayName`, which iOS usually fills
    /// in even though the token itself is opaque and the bundle id is withheld.
    /// Usually, not always — so every use of it is optional, and with nothing
    /// to go on the shield says what it always said.
    ///
    /// The second button is the part that has to be right. "View in Bouncer"
    /// on an app Bouncer has no feed for is a promise it cannot keep: the
    /// notification would carry someone here to be shown a platform picker
    /// they did not ask for. So it appears only for apps we can actually
    /// answer with, and an Instagram shield is a door with one way through
    /// rather than a door that lies.
    private func shield(appName: String? = nil) -> ShieldConfiguration {
        let platform = Gate.platformId(forAppNamed: appName)
        // For the action extension, which is handed a token and no name.
        Gate.lastShieldPlatform = platform
        // Proof of life, for the app to print later. If this stamp is NEVER
        // while a shield is demonstrably on screen, iOS drew its own — this
        // extension is not installed, not signed into the app group, or
        // crashing before it gets here — and no amount of editing the colours
        // below will change what the user sees.
        Gate.stampShieldRender()

        return ShieldConfiguration(
            // No blur: a blur composites the shielded app's own screen
            // through the colour, so the chosen ground would come out a
            // different shade over X than over anything else. Flat is the only
            // way this is the same colour every time.
            backgroundBlurStyle: nil,
            backgroundColor: Self.ink,
            icon: Self.icon(),
            title: ShieldConfiguration.Label(
                text: Self.titleText(),
                color: Self.accent
            ),
            // An EMPTY label, not nil.
            //
            // nil does not mean "no subtitle" — it means "you decide", and iOS
            // decides on its own copy: "You cannot use X because it is
            // restricted." Which is the sentence this whole screen exists to
            // avoid saying. The door is not a restriction and Bouncer is not
            // Screen Time telling you off.
            //
            // A label with an empty string is the only way to say "nothing
            // here" and be believed.
            subtitle: ShieldConfiguration.Label(text: "", color: .clear),
            // Accent fill, ink type. This is the button that was purple: it
            // was carrying the dark colour as its BACKGROUND, which made the
            // one solid shape on the screen the one colour that isn't Bouncer's.
            primaryButtonLabel: ShieldConfiguration.Label(
                // The app they were actually opening, when iOS says which.
                text: appName.map { "View in \($0)" } ?? "Continue",
                color: Self.ink
            ),
            primaryButtonBackgroundColor: Self.accent,
            // No background colour is available for the secondary button — iOS
            // draws it as plain text — so it carries the ink colour directly
            // and reads as the quieter of the two.
            secondaryButtonLabel: platform == nil ? nil : ShieldConfiguration.Label(
                text: "View in Bouncer",
                color: Self.accent
            )
        )
    }

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        shield(appName: application.localizedDisplayName)
    }

    override func configuration(
        shielding application: Application,
        in category: ActivityCategory
    ) -> ShieldConfiguration {
        shield(appName: application.localizedDisplayName)
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        shield()
    }

    override func configuration(
        shielding webDomain: WebDomain,
        in category: ActivityCategory
    ) -> ShieldConfiguration {
        shield()
    }
}
