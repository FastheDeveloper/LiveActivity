# GOTCHAS — every trap we hit (or know is coming), with symptom + fix

Format: **Symptom** → cause → **Fix**.

## Setup / scaffolding

- **`create-expo-app` refuses to scaffold into a non-empty directory** — even when the only
  content is a hidden `.claude/` folder. Symptom: `The directory ... has files that might be
  overwritten`. Fix: temporarily move the offending folder out, scaffold, move it back.
- **The Expo SDK 57 template ships its own `.claude/settings.json`, `CLAUDE.md`, and
  `AGENTS.md`** — if you had your own `.claude/` folder, restoring it after scaffolding can
  collide/nest. Merge the two by hand.

- **Android build fails with `[CXX1101] NDK at .../ndk/27.1.12297006 did not have a
  source.properties file`** — the NDK directory existed but was an empty husk from an aborted
  install (only a stale `.installer/` folder inside), which is enough to stop Gradle from
  auto-provisioning it. RN 0.86 pins NDK 27.1.12297006 exactly. Fix: delete the broken
  directory and reinstall: `sdkmanager --sdk_root=$ANDROID_HOME "ndk;27.1.12297006"`.
- **A piped `./gradlew assembleDebug | tail -5` reports exit code 0 even when the build
  fails** — the pipe swallows Gradle's exit status. Check `PIPESTATUS`/log for `BUILD
  SUCCESSFUL`, don't trust the pipeline's exit code.
- **Emulator system-image install fails with `Not in GZIP format`** — same disease as the NDK
  gotcha above, wider blast radius. An earlier disk-full episode left (a) the API 36 system-image
  directories as empty husks (only a `.installer/` stub inside — so the AVDs *looked* configured
  but could never boot), and (b) a 1.8 GB truncated `.asdownload` file in
  `$ANDROID_HOME/.downloadIntermediates` that the installer kept trying to resume, failing
  validation every time. Fix: delete the husk dirs AND the stale `.asdownload` intermediates
  (plus `$ANDROID_HOME/.temp/PackageOperation*`), then reinstall via
  `sdkmanager "system-images;android-36;google_apis;arm64-v8a"`.
  Lesson: an AVD's `config.ini` pointing at a system image proves nothing — check the image
  directory actually has files in it.
- **`No space left on device` at `:app:mergeDebugNativeLibs`** — an RN Android debug build is
  big (129 MB APK, multi-GB intermediates) and the pinned NDK adds ~2 GB more. Budget ~25 GB
  free before the first build; Xcode DerivedData, the CocoaPods cache, and the npm cache are
  the safe places to reclaim from.

- **`expo prebuild --clean` can die with `ENOTEMPTY: directory not empty, rmdir .../ios/Pods/...`**
  — a race while deleting the huge Pods tree (file watchers/Spotlight touching files mid-delete),
  leaving `ios/` half-deleted. Harmless in a CNG project: `rm -rf ios && npx expo prebuild -p ios`.
- **The widget's `DeliveryAttributes.swift` must be an EXACT copy of the module's** — app and
  extension compile separate copies; ActivityKit pairs them by type name + Codable shape at
  runtime. A drift doesn't error — the activity UI just silently never renders. (The `_shared`
  folder trick doesn't apply here: the module compiles as its own pod, not into the app target.)

- **Island/lock-screen blank even though the activity is running** — the activity was started
  by an app build that didn't yet contain the widget extension. Activities bind to the build
  that started them: adding the extension later doesn't retro-fix live ones, and nothing logs
  an error. End the stale activity and start a fresh one after every extension change.
- **Your own app's compact island UI never shows while the app is foreground** — switch to
  another app or lock the device before concluding it's broken.
- **Simulator screenshots can serve a frozen framebuffer** (clock stuck across minutes,
  `openurl` "works" but nothing changes) — `simctl shutdown` + `boot` fixes it.
- **`simctl push` with an `event: start` live-activity payload can silently no-op** — zero
  liveactivitiesd activity. Local starts work fine; simulator push-to-start needs separate
  investigation (APNs phase).

## Device / simulator matrix

- **iPhone 13 Pro (and anything pre-14 Pro) has no Dynamic Island.** Lock-screen Live
  Activities work fine, but compact/minimal/expanded island presentations can only be verified
  on a 14 Pro+ device or an iOS 18+ simulator (earlier sims can't preview the island properly).
- **Android Live Updates need API 36 (Android 16).** Below that, `ProgressStyle` promotion
  silently degrades to a plain ongoing notification: no status-bar chip, no segmented bar,
  no elevated lock-screen slot. Check emulator API level before debugging "missing" UI.

## Known traps we're watching for (from research — will confirm/annotate as we hit them)

### iOS
- Bundle-identifier collision: the widget extension must be `<app-bundle-id>.<suffix>`, and
  must NOT equal the app's bundle id.
- App Group must be added to BOTH targets (app + extension) or shared data silently fails.
- "Copy only when installing" checkbox on the extension's embed build phase — if checked,
  debug builds don't get the extension.
- APNs throttling: without `NSSupportsLiveActivitiesFrequentUpdates`, rapid pushes get
  budgeted/dropped.
- `content-state` shape mismatch in a push payload (vs. Swift `ContentState`) makes iOS drop
  the update **silently** — no error anywhere.
- Widget extensions have **no network**: images must be pre-fetched by the app and passed via
  the App Group container.
- **CONFIRMED — reinstalling the app can wedge chronod (the widget-platter daemon).** The
  first activity started right after `simctl install` hit `widgetDescriptorNotFound` (chronod's
  descriptor cache hadn't re-indexed the new extension), its retry never re-attached the
  running activity, and chronod logged XPC assertion failures. `pluginkit -m` showing the
  extension proves nothing — the daemon itself was stuck. End-and-restart the activity did
  NOT fix it; `simctl shutdown && boot` then a fresh activity did. Symptom: ActivityKit says
  `active`, zero island/lock UI, zero app-side errors.
- **The iOS simulator has no scriptable tap** (no uiautomator equivalent; synthetic clicks
  need macOS accessibility grants). Workaround: a `__DEV__`-only deep-link driver — Expo
  registers the bundle id as a URL scheme, so `simctl openurl booted
  <bundle-id>://drive/<action>` + a `Linking` listener drives the app. Wrinkle: `openurl`
  foregrounds the app, and the compact island hides while the app is foreground — re-open
  Safari before island screenshots.
- **A full JS reload orphans the activity** (React state holding `activityId` dies; the
  activity lives on for hours). Fast Refresh *can* hot-apply edits without losing it, but
  don't rely on it. The module looks activities up fresh by id, so a logged id is recoverable;
  an `endAll()` dev helper is the real fix.

### Android
- **CONFIRMED + it's worse than we thought: "Android 16" is two releases.** Base API 36
  (June 2025) has `ProgressStyle` but NOT `setRequestPromotedOngoing` /
  `setShortCriticalText` / the `POST_PROMOTED_NOTIFICATIONS` permission — those are SDK
  **36.1** (QPR, Sept 2025), and both report `SDK_INT == 36` (check
  `ro.build.version.sdk_full`). RN 0.86 compiles against base 36, so the platform promotion
  APIs don't even compile. Fix: `androidx.core:core-ktx:1.17.0` — NotificationCompat
  backports all three (promotion request rides an extra that QPR systems honor). Corollaries:
  - `NotificationManager.canPostPromotedNotifications()` exists on base 36 but **not on
    pre-QPR builds' runtime in practice** — wrap in `runCatching`.
  - Pre-QPR emulator/device shows the ProgressStyle bar but silently never promotes:
    `hasPromotableCharacteristics=false`, no chip, no lock-screen slot. Not your bug.
  - Below API 36, NotificationCompat.ProgressStyle degrades to **no progress bar at all** —
    keep a manual `setProgress(100, pct, false)` branch for pre-16.
- **CONFIRMED — promotion is all-or-nothing and silent.** On QPR everything flipped to true
  with permission + request + ongoing + title + ProgressStyle in place. Log
  `notification.hasPromotableCharacteristics()` after every build(); surface
  `canPostPromotedNotifications()` in your dev UI.
- **Notifee is officially dead** (repo archived 2026-04-07, last release Dec 2024,
  compileSdk 34) — don't burn an evaluation cycle on it; custom module is the only RN route
  to Live Updates as of mid-2026.
- **Emulator AVDs can have the keyguard disabled** — sleep/wake lands on the home screen and
  your lock-screen screenshot never shows. `adb shell locksettings set-disabled false`.
- **Piping emulator stdout through `head` kills the emulator** (SIGPIPE once it logs past
  your line budget) — looks like a mystery boot failure. Redirect to a file instead.
- Homebrew's `avdmanager` can't see images in `~/Library/Android/sdk` (it resolves its own
  SDK root from `toolsdir`) — an AVD is just two ini files; clone `~/.android/avd/<name>.avd/
  config.ini` and repoint `image.sysdir.1`.
- `setWhen(...)` must point to a **future** time or the update can be skipped. (Confirmed
  working as ETA display: future `when` + `setShowWhen(true)` renders "in 24m" in the header.)
- Re-posting must reuse the **same notification ID** or you get a new notification instead of
  an in-place update.
- OEM fragmentation: Samsung's Now Bar renders Live Updates differently from Pixel.
- Foreground service / WorkManager lifecycle: the update dies with the process unless a
  proper driver keeps it alive.
- **sdkmanager's downloader hangs forever on a dead socket** — 45 minutes, zero bytes written,
  no timeout, no error. `curl -fL --retry 10 -C -` against the same
  `dl.google.com/android/repository/sys-img/...` URL got the 1.7 GB in 58s. If sdkmanager
  stalls: curl the zip yourself, unzip into `system-images/<api>/<tag>/`, and hand-write a
  minimal `package.xml` so Android Studio stops offering to "install" it.
- **`create-expo-module --local modules/droptrack-live` creates `modules/modules/…`** — the CLI
  already prefixes `modules/`, so passing a path that includes it nests twice. Pass just the
  bare name (or nothing) and let it pick the location.
