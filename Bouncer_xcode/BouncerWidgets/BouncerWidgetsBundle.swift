//
//  BouncerWidgetsBundle.swift
//  BouncerWidgets
//
//  The widget extension's entry point. One widget today; the bundle exists so
//  a second one does not require touching the target.
//

import SwiftUI
import WidgetKit

@main
struct BouncerWidgetsBundle: WidgetBundle {
    var body: some Widget {
        PlatformTilesWidget()
    }
}
