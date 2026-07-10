# Gotchas

Every trap worth knowing when building Live Activities (iOS) and Live Updates (Android) in a React
Native / Expo project, with the symptom and the fix. Most of these fail silently, which is what
makes them expensive.

## Setup and build

- **`[CXX1101] NDK at .../ndk/27.1.12297006 did not have a source.properties file`** — the NDK
  directory exists but is an empty husk from an aborted install, which is enough to stop Gradle
  from auto-provisioning it. React Native 0.86 pins NDK 27.1.12297006 exactly. Delete the broken
  directory and reinstall: `sdkmanager --sdk_root=$ANDROID_HOME "ndk;27.1.12297006"`.
- **A piped `./gradlew assembleDebug | tail -5` reports exit code 0 even when the build fails** —
  the pipe swallows Gradle's exit status. Grep the log for `BUILD SUCCESSFUL` rather than trusting
  the pipeline's exit code.
- **Emulator system-image install fails with `Not in GZIP format`** — the same disease as the NDK
  husk, wider blast radius. A disk-full episode can leave the API 36 system-image directories as
  empty husks (so the AVDs look configured but never boot) and a truncated `.asdownload` file in
  `$ANDROID_HOME/.downloadIntermediates` that the installer keeps trying to resume. Delete the husk
  dirs and the stale intermediates (plus `$ANDROID_HOME/.temp/PackageOperation*`), then reinstall
  via `sdkmanager "system-images;android-36;google_apis;arm64-v8a"`. An AVD's `config.ini` pointing
  at a system image proves nothing; check the image directory actually has files in it.
- **`sdkmanager`'s downloader can hang forever on a dead socket** — zero bytes, no timeout, no
  error. Download the same `dl.google.com/android/repository/...` zip with `curl -fL --retry 10 -C -`,
  unzip it into `system-images/<api>/<tag>/`, and hand-write a minimal `package.xml` so Android
  Studio stops offering to install it.
- **`No space left on device` at `:app:mergeDebugNativeLibs`** — a React Native Android debug build
  is large and the pinned NDK adds a couple more GB. Budget roughly 25 GB free before the first
  build; Xcode DerivedData, the CocoaPods cache, and the npm cache are safe to reclaim from.
- **`expo prebuild --clean` can die with `ENOTEMPTY: directory not empty, rmdir`** — a race while
  deleting the large Pods or APK tree (file watchers touching files mid-delete). Harmless in a CNG
  project: `rm -rf ios && npx expo prebuild -p ios` (or `rm -rf android && npx expo prebuild -p android`).
- **`create-expo-module --local modules/droptrack-live` creates `modules/modules/…`** — the CLI
  already prefixes `modules/`, so passing a path that includes it nests twice. Pass the bare name.

## iOS Live Activities

- **The widget's `DeliveryAttributes.swift` must be an EXACT copy of the module's.** The app and the
  extension compile separate copies, and ActivityKit pairs them by type name and Codable shape at
  runtime. A drift does not error; the activity UI just silently never renders. A shared-folder
  trick does not help here, because the module compiles as its own pod rather than into the app
  target.
- **The widget extension's bundle id must be `<app-bundle-id>.<suffix>`** and must not equal the
  app's bundle id.
- **The App Group must be added to BOTH targets** (app and extension), or shared data silently fails.
- **"Copy only when installing"** on the extension's embed build phase means debug builds ship
  without the extension.
- **Widget extensions have no network access.** Pre-fetch images in the app and pass them through
  the App Group container.
- **Island or lock-screen blank even though the activity is running** — the activity was started by
  a build that did not yet contain the widget extension. Activities bind to the build that started
  them, and adding the extension later does not retro-fix live ones. End the stale activity and
  start a fresh one after every extension change.
- **The compact island never shows while your own app is in the foreground.** Switch to another app
  or lock the device before concluding it is broken.
- **Reinstalling can wedge `chronod`, the widget-platter daemon.** The first activity started right
  after `simctl install` can hit `widgetDescriptorNotFound`, and ending and restarting the activity
  does not clear it. `pluginkit -m` showing the extension proves nothing, because the daemon itself
  is stuck. Fix: `simctl shutdown && boot`, then start a fresh activity.
- **A full JS reload orphans the activity** — the React state holding `activityId` dies while the
  activity lives for hours. Log the id so it is recoverable, and add an `endAll()` development helper.
- **Tapping the Live Activity cold-starts your app, and your app has amnesia.** Live Activities are
  owned by the system and survive force-quit, but `activityId` normally lives in React state, so the
  user-triggered launch lands on a UI insisting nothing is being tracked. The activity is fine
  (`Activity.activities` still lists it; an APNs push returns 200, a dead one 410). Enumerate
  `Activity<T>.activities` on launch and on `AppState` active, re-attach, and recover the step from
  `activity.content.state`. Re-subscribe to `pushTokenUpdates` while you are there, because the
  previous process's `for await` loop died with it.
- **The iOS simulator has no scriptable tap** (no uiautomator equivalent; synthetic clicks need
  macOS accessibility grants). A `__DEV__`-only deep-link driver works: `simctl openurl booted
  <bundle-id>://drive/<action>` plus a `Linking` listener. Note that `openurl` foregrounds the app,
  and the compact island hides while the app is foreground.
- **Simulator screenshots can serve a frozen framebuffer** (clock stuck, `openurl` "works" but
  nothing changes). `simctl shutdown` and `boot` fixes it.

## APNs (push-driven iOS updates)

- **`pushType: .token` does nothing without the `aps-environment` entitlement.** `Activity.request`
  still succeeds and local updates still work, but `activity.pushTokenUpdates` never yields, and
  nothing errors. Add `aps-environment: development` to `ios.entitlements` in `app.json`, and
  confirm it survived signing: `codesign -d --entitlements - --xml <App>.app`.
- **The push token is per-ACTIVITY, not per-device.** It arrives asynchronously after
  `Activity.request` returns and can be rotated mid-flight. Consume `activity.pushTokenUpdates` (an
  `AsyncSequence`) rather than reading `activity.pushToken` once; a single read right after
  `request()` is usually nil.
- **`apns-topic` is `<bundle-id>.push-type.liveactivity`,** not the bare bundle id, and
  `apns-push-type: liveactivity` is required. A plain bundle-id topic is rejected.
- **Dev-signed builds must talk to `api.sandbox.push.apple.com`.** Hitting the production host with
  a sandbox token returns `400 BadDeviceToken`, which reads like a malformed token and sends you
  debugging the wrong layer.
- **ES256 JWTs need raw r‖s signatures.** Node's `crypto.sign` defaults to DER, which APNs rejects;
  pass `dsaEncoding: 'ieee-p1363'`. APNs is HTTP/2-only, so `fetch()` cannot talk to it; use
  `node:http2`.
- **Diagnose auth versus token errors without a device:** push to the sandbox with a fake device
  token. `400 BadDeviceToken` proves the JWT, `.p8`, team, and Key ID are all correct (APNs got far
  enough to look the token up). `403 InvalidProviderToken` means the key itself is wrong.
- **`aps.timestamp` is an ordering guard.** A push whose timestamp is older than the last one
  applied is silently discarded.
- **Two different "eta" shapes: the native-bridge shape is not the APNs content-state shape.** A JS
  `DeliveryState` built for the native module carries `etaEpochMillis` (Unix ms), which Swift
  converts to a `Date`. But an APNs push's `content-state` is decoded directly by the widget's
  Codable `ContentState`, which expects a field named `eta` holding seconds since 2001 and has no
  `etaEpochMillis`. Reuse the native-bridge object as a push payload and it is the classic silent
  drop: APNs returns 200, iOS discards it, nothing logs. Translate at the boundary.
- **Without `NSSupportsLiveActivitiesFrequentUpdates`,** rapid pushes get budgeted and dropped.
- **A 200 from APNs proves only that Apple accepted the bytes,** not that the card changed. Confirm
  on the lock screen.

## Testing on a physical device

- **A Debug build on a wired-only iPhone cannot reach Metro.** `react-native-xcode.sh` bakes the
  Mac's LAN IP into `ip.txt` inside the app, so off that network the app red-boxes with `No script
  URL provided`. There is no `adb reverse` equivalent on iOS. Build `--configuration Release` so the
  JS bundle is embedded; that is the more honest push harness anyway, because the app can be fully
  force-quit.
- **`xcrun devicectl device process launch --console` streams the app's stdout/stderr,** so `NSLog`
  is the reliable way to read a value like a push token off a device with no Metro connection.
- **`--payload-url` cold-starts the app,** so a deep link arrives via `Linking.getInitialURL()` and
  never fires the `'url'` event that the simulator's `simctl openurl` fires. A deep-link driver must
  handle both.
- **One phone has two identifiers.** `expo run:ios --device` wants the hardware UDID (from `xcrun
  xctrace list devices`); `devicectl` wants the CoreDevice identifier (from `xcrun devicectl list
  devices`). Passing one where the other belongs reads like the phone is unplugged.

## Android Live Updates

- **"Android 16" is two releases.** Base API 36 has `ProgressStyle` but not
  `setRequestPromotedOngoing`, `setShortCriticalText`, or the `POST_PROMOTED_NOTIFICATIONS`
  permission; those are API 36.1 (QPR). Both report `SDK_INT == 36` (read `SDK_INT_FULL` /
  `ro.build.version.sdk_full` to tell them apart). React Native 0.86 compiles against base 36, so
  the platform promotion APIs do not compile. Fix: `androidx.core:core-ktx:1.17.0`, whose
  `NotificationCompat` backports all three. Corollaries:
  - `NotificationManager.canPostPromotedNotifications()` can be unavailable and throw on some
    pre-QPR builds. Wrap it in `runCatching`.
  - A pre-QPR device shows the `ProgressStyle` bar but never promotes:
    `hasPromotableCharacteristics=false`, no chip, no lock-screen slot.
  - Below API 36, `NotificationCompat.ProgressStyle` degrades to no progress bar at all. Keep a
    manual `setProgress(100, pct, false)` branch for pre-16.
- **Promotion is all-or-nothing and silent.** It flips true only with permission, request, ongoing,
  a content title, an allowed style, importance above `MIN`, and not colorized. Log
  `notification.hasPromotableCharacteristics()` after every `build()`, and surface
  `canPostPromotedNotifications()` in a dev UI.
- **Custom `RemoteViews` are not allowed for promoted notifications.** You get the `ProgressStyle`
  template or no promotion.
- **Re-post under the same notification id,** or you get a second notification instead of an
  in-place update.
- **`setWhen(...)` must point to a future time** or the update can be skipped. One UI renders a
  future `when` as an absolute clock time, Pixel as a relative countdown.
- **Tapping the notification does nothing without a content intent.** `NotificationCompat` posts
  fine, but with no `setContentIntent(PendingIntent)` there is no tap target. Add a launch
  `PendingIntent` (`getLaunchIntentForPackage` + `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT`), keyed per
  activity. Verify with `dumpsys notification`.
- **Notifee is archived** (last release Dec 2024, `compileSdk 34`), with no Live Updates support. A
  custom module is the only React Native route.
- **Emulator AVDs can boot with the keyguard disabled** — the lock-screen screenshot never shows.
  `adb shell locksettings set-disabled false`.
- **Piping emulator stdout through `head` kills the emulator** (SIGPIPE once it logs past your line
  budget). Redirect to a file instead.
- **An AVD can point at a system image that is not installed** (empty husk), and the emulator FATALs
  with "Cannot find AVD system path". Use an installed `google_apis` image, which also has Play
  Services, all FCM needs.
- **FCM needs Google Play services** — use a `google_apis` (or `_playstore`) emulator image, not a
  bare AOSP one. Verify with `adb shell pm list packages | grep com.google.android.gms`.

## FCM (push-driven Android updates)

- **A `notification` FCM message never reaches your code when backgrounded.** Only a data-only
  message routes to `FirebaseMessagingService.onMessageReceived` while the app is backgrounded or
  killed; a message with a `notification` block is handled by the system tray and your re-post code
  never runs. Send data-only with `android.priority: "high"`.
- **The messaging service cannot see the module's in-memory state.** It is a separate entry point
  and may run with the module instance dead, so the data payload must carry every field needed to
  rebuild the notification. Extract a shared notification builder that both the module and the
  service call from plain parameters.
- **A push updates the notification but not the app's UI.** The service is a separate entry point
  from the app's JS state. To keep an in-foreground app in sync, bridge the service to JS with a
  `@Volatile` static emitter on the module (set in `OnCreate`, cleared in `OnDestroy`) that
  `sendEvent`s to JS after `notify()`. It no-ops when the app is dead, which is fine, because the
  notification still updates.
- **A cold-started app comes up empty.** Android has no `Activity.activities` equivalent, so persist
  the delivery to `SharedPreferences` on every `notify()` and read it back on launch. Guard the
  rehydration with `getActiveNotifications()`, or a stale record produces an uncancellable phantom
  delivery. Make teardown forgiving so a cold-started Cancel does not throw.
- **FCM error codes differ from APNs.** A malformed token returns `400 INVALID_ARGUMENT`; a
  well-formed but unregistered token returns `404 UNREGISTERED`. APNs collapses both into
  `BadDeviceToken`. A fabricated token in an auth probe returns `INVALID_ARGUMENT`, not
  `UNREGISTERED`; either proves auth is fine, since a bad service account gives `401/403`.
- **FCM v1 auth is a service-account RS256 JWT exchanged for an OAuth token,** not a one-shot `.p8`.
  Mint the JWT (scope `firebase.messaging`), exchange it at `oauth2.googleapis.com/token`, then
  bearer the access token to `/v1/projects/<id>/messages:send`. FCM v1 is plain HTTPS, so `fetch`
  works.
- **`google-services` must be wired through CNG.** `android/` is generated by prebuild, so a config
  plugin has to re-place `google-services.json` into `android/app/` and re-add the Gradle wiring on
  every prebuild. Have it throw at prebuild when the file is missing.
- **A data message can be dropped under Doze or after a force-kill,** unlike a system-owned iOS Live
  Activity. High priority helps. Test backgrounded (Home), not swiped away. This is a platform
  limitation to document, not a bug to engineer around.

## Device and OEM matrix

- **Pre-14 Pro iPhones have no Dynamic Island.** Lock-screen Live Activities work, but the
  compact/minimal/expanded island presentations need a 14 Pro or newer, or an iOS 18+ simulator.
- **Samsung ships base 36, and the OEM behavior is worse than the version number suggests.** On a
  base-36 One UI device, the capability checks disagree: `hasPromotableCharacteristics()` returns
  true (backported framework bits) while `canPostPromotedNotifications()` returns false, whereas a
  base-36 Pixel emulator returns false for both. Never infer one check from the other.
- **One UI 8.5 (SDK 36.1) grants the promotion but withholds the surfaces.**
  `canPostPromotedNotifications()` returns true and `FLAG_PROMOTED_ONGOING` lands on the
  notification (verify in `dumpsys`), giving top-of-shade pinning and a status-bar icon, but no chip
  pill, no lock-screen card, and no Now Bar entry. The headline surfaces are gated behind a
  fixed per-app allowlist in Samsung's Live notifications settings. Do not equate "promotion
  granted" with "promoted UI shown" on Samsung.
- **Samsung Remote Test Lab is scriptable.** Its Remote Debug Bridge is a local adb tunnel
  (`adb devices` shows `localhost:<port>`), so granting permissions, tapping, screencap, and
  `dumpsys` all work on the remote phone. Traps: it is an x86_64 binary (slow first start under
  Rosetta), it ignores CLI flags and just starts its server, and two instances fight over the web
  client, so run exactly one. Build an arm64-only release APK
  (`-PreactNativeArchitectures=arm64-v8a`), since the remote device cannot reach Metro.
- **Remote Test Lab devices can boot in landscape,** so taps computed from a portrait screencap land
  on the wrong UI. Check rotation first and force it with `settings put system user_rotation 0`.
  Lock screens doze in seconds; run `svc power stayon true` before lock-screen captures.
