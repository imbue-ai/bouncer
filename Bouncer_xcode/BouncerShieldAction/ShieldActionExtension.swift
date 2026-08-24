//
//  ShieldActionExtension.swift
//  BouncerShieldAction
//
//  What the two buttons do. This is the load-bearing extension: everything
//  else in the feature is setup or aftermath.
//
//  It runs for a few hundred milliseconds, in its own process, with no UI and
//  no way to present any. It cannot open an app. It cannot ask a question. It
//  gets a button, and a completion handler, and whatever it can finish before
//  iOS takes the process away.
//
//  So both paths are written to be finished, not started. Nothing here waits on
//  a network call or a callback that might outlive us: the state goes into the
//  App Group synchronously, the shield is changed synchronously, monitoring is
//  requested synchronously, and only then does the completion fire.
//

import Foundation
import FamilyControls
import ManagedSettings
import UIKit

class ShieldActionExtension: ShieldActionDelegate {

    override func handle(
        action: ShieldAction,
        for application: ApplicationToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        respond(to: action, completionHandler: completionHandler)
    }

    override func handle(
        action: ShieldAction,
        for webDomain: WebDomainToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        respond(to: action, completionHandler: completionHandler)
    }

    override func handle(
        action: ShieldAction,
        for category: ActivityCategoryToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        respond(to: action, completionHandler: completionHandler)
    }

    // MARK: -

    private func respond(to action: ShieldAction,
                         completionHandler: @escaping (ShieldActionResponse) -> Void) {
        // Proof of life — see Gate.lastShieldActionAt. A shield whose buttons
        // do nothing and a shield we never received the tap from look identical
        // from the app; this separates them.
        Gate.stampShieldAction()

        switch action {
        case .primaryButtonPressed:
            // "View in X" — go on into the app they were opening.
            //
            // `.defer` rather than `.close`: the shield settings have already
            // been cleared synchronously above, so deferring makes iOS
            // re-evaluate and drop a shield that no longer applies, leaving them
            // in X. `.close` would send them to the home screen to open
            // it a second time, which is a tax on the button people press when
            // someone is waiting on a reply.
            //
            // If the window could not be opened the shield is still up and
            // deferring would dismiss it over an app we have not unblocked, so
            // that path answers `.none` and the tap reads as "that didn't
            // work" — which is at least true.
            completionHandler(openEngageWindow() ? .defer : .none)

        case .secondaryButtonPressed:
            // "View in Bouncer" — leave the app entirely; the notification carries
            // them to Bouncer, since an extension cannot open one itself.
            //
            // Answering only once the request has been accepted. `add` is
            // asynchronous, and this completion handler is what tells iOS the
            // extension may be killed — so answering first raced the request
            // against the teardown, and the request lost. That is the whole of
            // why this button appeared to do nothing.
            GateNotifications.postHandoff { completionHandler(.close) }

        case .firstSecondarySubmenuItemPressed,
             .secondSecondarySubmenuItemPressed,
             .thirdSecondarySubmenuItemPressed:
            // Submenu items, from a submenu this shield does not configure —
            // the fork is two buttons and nothing else, deliberately (see the
            // note in ShieldConfigurationExtension about "just this once").
            // iOS 26.4 added them and iOS should never send one to us; they are
            // named rather than left to `@unknown default` so that stays a
            // statement about FUTURE cases, which is the only thing it can
            // usefully warn about.
            //
            // Safe below the deployment target despite the cases being iOS
            // 26.4+: an enum case pattern compiles to a raw-value comparison,
            // with nothing to look up at runtime.
            completionHandler(.none)

        @unknown default:
            completionHandler(.none)
        }
    }

    /// Lift the shield for a measured number of minutes of use. Returns whether
    /// the window actually opened — the caller has to know, because letting
    /// someone through without a way to close the door behind them is the one
    /// outcome worse than refusing.
    @discardableResult
    private func openEngageWindow() -> Bool {
        // Written before the shield comes down, not after. If we are killed
        // between the two, an open window with the shield still up is a gate
        // that is merely annoying; a down shield with no record of why is a
        // gate that has silently stopped existing.
        Gate.sessionOpenedAt = Date()

        let selection = Gate.selection ?? FamilyActivitySelection()
        let failure = GateSchedule.startMonitoring(selection: selection)

        // If Device Activity would not take the job, nothing will ever close
        // this window — no timer survives here, and the app may not be opened
        // for hours. Better to refuse the promise than to make one that only
        // ends when the user notices.
        if failure != nil {
            Gate.sessionOpenedAt = nil
            return false
        }

        let store = Gate.store
        store.shield.applications = nil
        store.shield.applicationCategories = nil
        store.shield.webDomains = nil
        return true
    }
}
