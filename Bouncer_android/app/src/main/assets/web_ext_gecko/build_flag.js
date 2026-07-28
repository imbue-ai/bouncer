// Overridden by app/src/debug/assets (build-type assets win the merge), so
// debug APKs get `true` here while release APKs keep this default. Both APK
// variants embed the same prod-env JS bundle, so this is the only signal the
// content scripts have for "this is a debug build" (used to gate debug-only
// affordances like the long-press reasoning popup).
window.__ff_debugBuild = false;
