# Path B — Release builds with Play Integrity

End-to-end runbook for getting Firebase App Check via Play Integrity working
on release builds. Debug builds use the `DebugAppCheckProvider` and are
unaffected by this document.

## Status checkpoints

- [x] **Step 1** — Release keystore created at `~/keystores/bouncer-release.jks` (PKCS12).
- [x] **Step 2** — `app/build.gradle.kts` reads `BOUNCER_RELEASE_*` from `local.properties` and signs release builds with that keystore; falls back to the debug keystore with a `logger.warn(...)` if any property is missing.
- [x] **Step 3** — Built AAB at `app/build/outputs/bundle/release/app-release.aab` via Android Studio (`Build → Generate App Bundles`).
- [x] **Step 4** — Play Console listing created (Free; data safety form submitted).
- [x] **Step 5** — AAB uploaded to internal testing; Play App Signing accepted; both SHA-256 fingerprints retrieved.
- [x] **Step 6** — Both SHA-256 fingerprints (app signing + upload) registered with Firebase; `google-services.json` refreshed in `app/`.
- [x] **Step 7** — Play Integrity API already enabled in Google Cloud for `bouncer-180ba`.
- [x] **Step 8** — Play Integrity linked to the Play Console app (Cloud project `bouncer-180ba`).
- [x] **Step 9** — Added as internal tester; opt-in URL distributed.
- [x] **Step 10** — Installed on the Pixel via Play Store.
- [x] **Step 11** — Verified in Logcat (Play Integrity → App Check → WebSocket open with token).

## Reference values

Upload-key SHA-256 (from `apksigner verify --print-certs app-release.apk`):

```
ae:78:86:b4:7a:91:e3:ca:37:3c:dd:5f:af:4b:0b:1c:dc:5f:d8:2d:5e:9c:ef:f5:18:87:f1:f2:9b:b4:86:51
```

Re-derive at any time with:

```bash
~/Library/Android/sdk/build-tools/$(ls ~/Library/Android/sdk/build-tools/ | sort -V | tail -1)/apksigner \
  verify --print-certs \
  <repo-root>/Bouncer_android/app/build/outputs/apk/release/app-release.apk
```

Firebase project: `bouncer-180ba`. Android package: `com.imbue.bouncer`.

## Step 3 — Build the AAB

Play requires `.aab`, not `.apk`:

```bash
./gradlew :app:bundleRelease
```

(`JAVA_HOME` and `PATH` are exported in `~/.zshrc` to point at Android Studio's bundled JBR. A fresh shell picks them up automatically.)

Output: `app/build/outputs/bundle/release/app-release.aab`.

## Step 4 — Create the Play Console listing

Prerequisite: Google Play Developer account ($25 one-time, https://play.google.com/console/signup).

1. https://play.google.com/console → **Create app**.
2. Fill in:
   - **App name**: Bouncer
   - **Default language**: English (US)
   - **App or game**: App
   - **Free or paid**: Free
   - Accept Developer Program Policies + US export laws.
3. **Create app**.
4. Complete the dashboard items that gate internal testing (skip everything else — store listing copy / screenshots / pricing are not required for internal):
   - Privacy Policy (hosted URL).
   - App access (declare login requirement + provide tester credentials if needed).
   - Ads (no).
   - Content rating (questionnaire).
   - Target audience (age range).
   - News app (no).
   - COVID-19 contact tracing (no).
   - Data safety (form describing data collected: Twitter cookies, App Check tokens, etc.).
   - Government / financial / health features (no).

## Step 5 — Upload to internal testing & accept Play App Signing

1. Left nav: **Test and release → Testing → Internal testing**.
2. **Create new release**.
3. On first upload, Play prompts about **Play App Signing**. **Accept it.** Google now holds the production signing key in escrow; your local keystore is the upload key.
4. Drag in `app-release.aab`.
5. Add release notes ("initial internal release" is fine).
6. **Save** → **Review release** → **Start rollout to Internal testing**.

After upload completes: **App integrity → App signing** (left nav under "Test and release"). Copy both SHA-256s shown there:

- **App signing key certificate** SHA-256 — Google's, used by Play Integrity.
- **Upload key certificate** SHA-256 — yours.

## Step 6 — Register fingerprints with Firebase

1. https://console.firebase.google.com → project **bouncer-180ba**.
2. Gear icon → **Project settings** → **General**.
3. **Your apps** → click `com.imbue.bouncer`.
4. **Add fingerprint** → paste **app signing key SHA-256** from Step 5. Save.
5. **Add fingerprint** again → paste **upload key SHA-256**. Save.
6. **Download `google-services.json`** at the top of that section.
7. Replace the existing file:
   ```bash
   mv ~/Downloads/google-services.json \
      <repo-root>/Bouncer_android/app/google-services.json
   ```

## Step 7 — Enable Play Integrity API in Google Cloud

1. https://console.cloud.google.com → project picker → select **bouncer-180ba**.
2. **APIs & Services → Library**.
3. Search "Play Integrity API" → click → **Enable**.

Allow a minute for propagation.

## Step 8 — Link Play Integrity to the Play Console app

1. Play Console → your app → **App integrity → Play Integrity API → Settings**.
2. Confirm/select linked Google Cloud project: **bouncer-180ba**.
3. Leave other settings at defaults (standard requests, no caching). Firebase handles the call format.

## Step 9 — Add yourself as a tester

1. Play Console → **Test and release → Testing → Internal testing → Testers** tab.
2. **Create email list**, name it "Internal", add your Gmail. Save.
3. Tick the "Internal" checkbox so it's enabled for this track.
4. Scroll to **How testers join your test** → copy the opt-in URL.

## Step 10 — Install via Play Store on the Pixel

**Required.** Play Integrity returns `PLAY_RECOGNIZED` only for installs that came from Play Store with the matching signing key. Sideloaded copies of the same APK return `UNRECOGNIZED_VERSION` and Firebase rejects.

1. Uninstall any local install:
   ```bash
   ~/Library/Android/sdk/platform-tools/adb -s 54031JEBF14744 shell pm uninstall com.imbue.bouncer
   ```
2. On the Pixel (signed in as the tester Gmail), open the opt-in URL from Step 9 in Chrome.
3. **Become a tester** → wait a few minutes → **Download it on Google Play** → install normally.

(Sometimes the release isn't immediately visible; give it 5–15 min after **Start rollout**.)

## Step 11 — Verify

Android Studio Logcat filter:

```
package:com.imbue.bouncer & (tag:AppCheck | tag:WebSocketBridge)
```

Expected on first WS attempt after launch:

```
AppCheck         configure: DEBUG=false factory=PlayIntegrityAppCheckProviderFactory debugTokenLen=…
AppCheck         warmup ok len=941
WebSocketBridge  open ws_N -> wss://...&token_ios=…(941 chars)
WebSocketBridge  onOpen ws_N
```

`debugTokenLen` may be 36 if `local.properties` still has `firebaseAppCheckDebugToken=…`. That's fine — the release build picks Play Integrity based on `BuildConfig.DEBUG`, not on the token's presence. The token is just unused in release.

## Failure modes

- `Integrity API error (-8): too many requests` → throttle; wait 5–10 min. Routine during the first hour after enrollment.
- `Integrity API error (-2): UNRECOGNIZED_VERSION` → either sideloaded instead of installing from Play, or the Firebase SHA-256 doesn't match what Play actually signed with. Re-check Steps 6 and 10.
- `403: App attestation failed` from Firebase → JWT was minted by Play but Firebase rejected it. Almost always means `google-services.json` wasn't replaced (Step 6), or only one of the two fingerprints was registered.

## What to do every release after this

1. Bump `versionCode` in `app/build.gradle.kts`.
2. `./gradlew :app:bundleRelease`.
3. Play Console → Internal testing → **Create new release** → upload the new AAB → roll out.
4. No Firebase or keystore changes needed unless the upload key rotates (Google's app signing key never rotates after enrollment).
