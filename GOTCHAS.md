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
  investigation. (TSK-3 note: real-device `event: update`/`end` pushes over APNs work fine,
  so this is a simulator/push-to-start issue, not a payload-shape one.)

## APNs / push-driven updates (TSK-3)

- **`pushType: .token` is not enough — the app needs the `aps-environment` entitlement.**
  Without it `Activity.request` still succeeds and the activity runs happily on local
  updates; `activity.pushTokenUpdates` just never yields. Nothing errors. Add
  `aps-environment: development` to `ios.entitlements` in `app.json` (and confirm it survived
  signing: `codesign -d --entitlements - --xml <App>.app`).
- **The push token is per-ACTIVITY, not per-device**, arrives asynchronously *after*
  `Activity.request` returns, and can be rotated by the system mid-flight. Consume
  `activity.pushTokenUpdates` (an `AsyncSequence`) rather than reading `activity.pushToken`
  once — a single read right after `request()` is usually nil.
- **`apns-topic` is `<bundle-id>.push-type.liveactivity`**, not the bare bundle id, and
  `apns-push-type: liveactivity` is required. A plain bundle-id topic is rejected.
- **Dev-signed builds must talk to `api.sandbox.push.apple.com`.** Hitting the production
  host with a sandbox token returns `400 BadDeviceToken` — which reads like a malformed
  token and sends you debugging the wrong thing.
- **Diagnosing APNs auth vs. token errors:** push to the sandbox with a *fake* device token.
  `400 BadDeviceToken` proves the JWT/`.p8`/team/key-id are all correct (APNs got far enough
  to look the token up). `403 InvalidProviderToken` means the key itself is wrong. This
  separates the two failure classes before a device is even involved.
- **ES256 JWTs need raw r‖s signatures.** Node's `crypto.sign` defaults to DER, which APNs
  rejects — pass `dsaEncoding: 'ieee-p1363'`. And APNs is HTTP/2-only, so `fetch()` can't
  talk to it; use `node:http2`.
- **`aps.timestamp` is an ordering guard**: a push whose timestamp is older than the last one
  applied is silently discarded.
- **Two different "eta"s: the native-bridge shape ≠ the APNs content-state shape.** A JS
  `DeliveryState` built for the native module carries `etaEpochMillis` (Unix ms), which the
  Swift `Record` converts to a `Date`. But an APNs push's `content-state` is decoded DIRECTLY
  by the widget's Codable `ContentState`, which expects a field literally named `eta` holding
  seconds-since-2001 and has no `etaEpochMillis`. Reuse the native-bridge object as an APNs
  payload and it's the classic silent drop: APNs returns 200, iOS discards it, nothing logs.
  Translate at the APNs boundary (strip `etaEpochMillis`, emit Apple-epoch `eta`). Bit us the
  moment a second code path (the web dispatcher) reused the shared `toDeliveryState()`.

## Driving a physical device (no simulator tricks)

- **A Debug build on a wired-only iPhone can't reach Metro.** `react-native-xcode.sh` bakes
  the Mac's *LAN* IP into `ip.txt` inside the .app; if the phone is on cellular or a different
  network, the app red-boxes with `No script URL provided … unsanitizedScriptURLString =
  (null)`. There is no `adb reverse` equivalent on iOS. Either put the phone on the same
  Wi-Fi, or build `--configuration Release` so the JS bundle is embedded and Metro is
  irrelevant. For push testing, the Release build is the more honest harness anyway: the app
  can be fully force-quit.
- **`xcrun devicectl device process launch --console` streams the app's stdout/stderr**, so
  `NSLog` is the only reliable way to read a value (like a push token) off a device with no
  Metro connection — RN's `console.log` goes to Metro, not the system log.
- **`--payload-url` cold-starts the app**, so the URL arrives via `Linking.getInitialURL()`
  and never fires the `'url'` event. The simulator's `simctl openurl` does the opposite (hits
  a running app, fires the event). A deep-link test driver must handle both or device driving
  silently no-ops. Note `__DEV__` is false in Release, which strips the driver entirely.

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
- **CONFIRMED — tapping the Live Activity cold-starts your app, and your app has amnesia.**
  Live Activities are owned by the system, not your process: they survive force-quit and
  relaunch. But `activityId` normally lives in React state, so the launch that the *user
  triggered by tapping the card* lands on a UI insisting nothing is being tracked, with every
  control disabled — while the card sits on the lock screen. The activity is fine
  (`Activity.activities` still lists it; an APNs push still returns 200, and a dead one
  would return 410). The fix is to enumerate `Activity<T>.activities` on launch and re-attach,
  recovering the current step from `activity.content.state`. Re-subscribe to
  `pushTokenUpdates` while you're there — the previous process's `for await` loop died with
  it, so a token rotation after relaunch would otherwise go unnoticed.

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
  working as ETA display: future `when` + `setShowWhen(true)` renders "in 24m" in the header.
  OEM note: One UI renders the same future `when` as absolute clock time, "2:46 PM".)
- **CONFIRMED on real hardware — Samsung ships base 36, and the OEM matrix is worse than the
  version number suggests.** Galaxy S25 Ultra, One UI 8.0 (July 2026): `sdk_full=36.0`, no
  promotion pipeline, no chip, no promoted lock-screen card. And the capability checks
  disagree across devices running "the same" Android 16: Samsung returns
  `hasPromotableCharacteristics()=true` (backported framework bits) while
  `canPostPromotedNotifications()=false`; base-36 Pixel emulator returns false for BOTH.
  Never infer one check from the other.
- **Samsung's Now Bar is allowlisted, not open** (One UI 8.0): per-app
  `key_now_bar_<package>` keys in the system settings table, partner apps only (Naver on KR
  units); writing your own key does nothing, and per-app notification settings expose no
  "Live updates" toggle for third parties.
- **One UI 8.5 (S26, sdk_full=36.1) grants the promotion but withholds the surfaces**:
  `canPostPromotedNotifications()=true` and `FLAG_PROMOTED_ONGOING` actually lands on the
  notification (verify in dumpsys) — you get top-of-shade pinning and the status-bar icon,
  but no chip pill, no lock-screen card, and the Now Bar still ignores third-party Live
  Updates. Don't equate "promotion granted" with "promoted UI shown" on Samsung.
- **RTL devices can boot in landscape** — taps computed from a portrait screencap land on
  random UI (ours opened Galaxy AI onboarding). Check `wm size`/rotation first; force with
  `settings put system user_rotation 0`. Lock screens doze in seconds: `svc power stayon
  true` before lock-screen captures.
- **Samsung Remote Test Lab is scriptable**: the Remote Debug Bridge binary is a local adb
  tunnel (`adb devices` shows `localhost:<port>`) — grant permissions, tap, screencap,
  dumpsys, all of it works on the remote phone. Traps: x86_64 binary (Rosetta, slow first
  start), it ignores CLI flags and always just starts its server, and two instances fight
  over the web client — run exactly one. Build an arm64-only release APK
  (`-PreactNativeArchitectures=arm64-v8a`) since the remote device can't reach Metro.
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

## Android FCM push-driven Live Updates (TSK-5)

- **A `notification` FCM message never reaches your code when backgrounded.** Only a
  **data-only** message routes to `FirebaseMessagingService.onMessageReceived` while the app is
  backgrounded/killed; a message with a `notification` block is handled by the system tray and
  your re-post code never runs. Send data-only + `android.priority: "high"`.
- **The messaging service can't see the module's in-memory state.** It's a separate entry point
  (the module instance may be dead). The data payload must carry every field needed to rebuild
  the notification. We extracted `DeliveryNotifier` so both the module and the service build the
  identical notification from plain params.
- **FCM error codes differ from APNs.** A malformed token → `400 INVALID_ARGUMENT`; a
  well-formed but unregistered token → `404 UNREGISTERED`. APNs collapses both into
  `BadDeviceToken`. So a fabricated token in an auth probe returns `INVALID_ARGUMENT`, not
  `UNREGISTERED` — either proves auth is fine (a bad service account gives `401/403`).
- **FCM v1 auth is a service-account RS256 JWT → OAuth token**, not a one-shot `.p8` like APNs.
  Mint the JWT (scope `firebase.messaging`), exchange at `oauth2.googleapis.com/token`, then
  bearer the access token to `/v1/projects/<id>/messages:send`. FCM v1 is plain HTTPS (fetch
  works); APNs is HTTP/2.
- **`google-services` must be wired through CNG.** `android/` is generated by prebuild, so a
  config plugin (`plugins/withAndroidFcm.js`) has to (re)place `google-services.json` into
  `android/app/` and add the `com.google.gms:google-services` classpath + apply-plugin every
  prebuild. Missing `google-services.json` → the plugin throws at prebuild (intended fail-fast).
- **`expo prebuild --clean` dies with `ENOTEMPTY … android/app/build/outputs/apk`** (a delete
  race, same as the iOS Pods one). Fix: `rm -rf android && npx expo prebuild -p android`.
- **An AVD can point at a system image that isn't installed** (empty husk): `s25-qpr` targeted
  `android-36.1/google_apis` which was never downloaded → emulator FATALs with "Cannot find AVD
  system path." Check the image dir has real files; `s25` (android-36 google_apis, installed)
  boots and has Play Services, which is all FCM needs.
- **FCM needs Google Play Services** — use a `google_apis` (or `_playstore`) emulator image, not
  a bare AOSP one. Verify: `adb shell pm list packages | grep com.google.android.gms`.
- **Reliability gap vs iOS:** a data message can be dropped under Doze or after a force-kill —
  unlike a system-owned iOS Live Activity. High priority helps; test backgrounded (Home), not
  swiped-away. This is a platform limitation, not a bug — document it.

- **Tapping a Live Update notification does nothing (just expand/collapse) without a content
  intent.** `NotificationCompat` posts fine, but with no `setContentIntent(PendingIntent)`
  there's no tap target. Add a launch `PendingIntent` (`getLaunchIntentForPackage` +
  `FLAG_IMMUTABLE|FLAG_UPDATE_CURRENT`), keyed per activity so distinct deliveries don't
  collide. Verify: `dumpsys notification` shows `contentIntent=PendingIntent{… startActivity}`.
- **A push updates the notification but NOT the app's UI** — the `FirebaseMessagingService` is a
  separate entry point from the app's JS state (and may run with the module instance dead). To
  keep an in-foreground app's UI in sync, bridge the service to JS: a `@Volatile` static emitter
  on the module (set in `OnCreate`, cleared in `OnDestroy`) that `sendEvent`s an `onDeliveryPush`
  to JS; the service calls it after `notify()`. No-op when the app is killed (nothing to update)
  — the notification still updates. This is the Android analog of the iOS foreground resync.
