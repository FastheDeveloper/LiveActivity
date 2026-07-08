# DEVLOG — DropTrack

Chronological build log for the React Native Live Activity (iOS) + Live Updates (Android) demo.
Raw material for the article — every step, decision, and breakage gets recorded here as it happens.

---

## 2026-07-08 — Phase 0: Ideation & setup

### Environment check (before any code)

| Item | Version / status |
|---|---|
| macOS | 26.1 (25B78) |
| Xcode | 26.3 (17C529), CLT configured |
| Node | 20.19.4 (npm 10.8.2) |
| iOS simulators | 18.0, 18.1, 18.2, 18.4, 18.5, 26.0, 26.2 |
| Physical iPhone | iPhone 13 Pro, iOS 26.x, paired |
| Apple team | Recdek Ltd, V993Z3KD7P — **paid** membership → APNs push phase unlocked |
| Android SDK | platforms 33–36, build-tools 36.x, `ANDROID_HOME` set |
| Android emulators | `Medium_Phone` + `s25`, both configured for API 36 (Android 16) → full Live Updates treatment testable. **Correction (first boot attempt):** both AVDs' system images turned out to be empty husks from aborted installs — the AVD configs existed but the images had no files. Reinstalled `google_apis;arm64-v8a` for API 36; see GOTCHAS. |
| Java | OpenJDK 17 (Zulu) |
| FCM | Not set up — Android remote-update phase (A4) is gated on this |

Notable: the iPhone 13 Pro supports lock-screen Live Activities but has **no Dynamic Island**
(that needs 14 Pro or later) — all Dynamic Island verification happens on the iOS 18+ simulator.

### Decisions

- **App identity**: `DropTrack`, bundle/package `com.fasarticle.droptrack`, widget extension
  will be `com.fasarticle.droptrack.widgets`, App Group `group.com.fasarticle.droptrack`.
- **Stack**: Expo managed + prebuild, `@bacons/apple-targets` for the widget target.

### 📝 ARTICLE — `expo-live-activity` package vs. custom Expo native module

We chose a **custom Expo native module** over the off-the-shelf `expo-live-activity` package.

The tradeoff: the package gets you to first render fastest, but it ships a *predefined* widget
layout and a fixed `ContentState` shape. Our demo needs a custom Chowdeck-style segmented
capsule progress bar, a rider-reassignment state, and our own Dynamic Island layouts — all of
which require owning `ActivityAttributes`/`ContentState` and the SwiftUI. With the package we'd
be ejecting by Phase 1 anyway. The custom module is ~100 lines of Swift
(`start` / `update` / `end` / `areActivitiesEnabled` / push-token listener), every line of which
we can explain in the article.

### 📝 ARTICLE — Android bridge decision (provisional, verify at A1)

Same custom Expo module will get a **Kotlin implementation** alongside the Swift one — one
module, one JS API, two platform backends. That symmetry is the article's comparison chapter.
Before writing Kotlin we'll formally evaluate **Notifee**, but the expectation is it doesn't
expose `ProgressStyle` or `setRequestPromotedOngoing` (API 36 is too new). To be verified
against Notifee's current docs at A1 and recorded here.

### Scaffold

```bash
npx create-expo-app@latest . --template blank-typescript --yes
```

Pinned versions from the scaffold: **Expo SDK 57.0.4, React Native 0.86.0, React 19.2.3,
TypeScript 6.0.3**. `create-expo-app@4.0.0`.

Two small snags (see GOTCHAS.md): create-expo-app refuses a non-empty directory (even one
containing only a `.claude/` folder), and the SDK 57 template now ships its own
`.claude/settings.json` + `CLAUDE.md` + `AGENTS.md`.

create-expo-app initialized git and made the initial commit itself.

### Config

- Added `@bacons/apple-targets@4.0.7`.
- `app.json`: set name/slug, `ios.bundleIdentifier`, `android.package`, `ios.appleTeamId`,
  `NSSupportsLiveActivities: true`, `NSSupportsLiveActivitiesFrequentUpdates: true`
  (declares intent to update more often than APNs' default Live Activity budget),
  App Group entitlement, and the `@bacons/apple-targets` plugin with the team ID.
- Created docs files (this file, GOTCHAS.md, ARTICLE_NOTES.md, README.md, screenshots/).

### Prebuild

```bash
npx expo prebuild   # generates ./ios and ./android, runs pod install
```

Clean run. Verified the config plugin output landed:

- `ios/DropTrack/Info.plist` → `NSSupportsLiveActivities` + `NSSupportsLiveActivitiesFrequentUpdates` both `true`.
- `ios/DropTrack/DropTrack.entitlements` → App Group `group.com.fasarticle.droptrack`.
- `android/app/build.gradle` → `applicationId 'com.fasarticle.droptrack'`.

One benign warning: `android: userInterfaceStyle: Install expo-system-ui to enable this
feature` — cosmetic, ignored for the demo.

Then verified both platforms build clean from the generated projects:

```bash
# iOS (simulator, Debug)
xcodebuild -workspace ios/DropTrack.xcworkspace -scheme DropTrack \
  -configuration Debug -sdk iphonesimulator build
# Android
cd android && ./gradlew assembleDebug
```

**iOS: BUILD SUCCEEDED first try.**

**Android: failed twice before succeeding** — both environment problems, not project problems,
and both worth having in the article as "what real setup looks like":

1. `[CXX1101] NDK at .../ndk/27.1.12297006 did not have a source.properties file` — the NDK
   version RN 0.86 pins existed on disk as an **empty husk** from an aborted install (just a
   stale `.installer/` folder), which blocked Gradle from auto-provisioning it. Fix: delete the
   directory, `sdkmanager --sdk_root=$ANDROID_HOME "ndk;27.1.12297006"` (~2 GB download).
2. `No space left on device` during `:app:mergeDebugNativeLibs` — the NDK download had left the
   data volume at 100% (196 MB free). Freed ~18 GB by deleting regenerable caches only: other
   projects' Xcode DerivedData, the CocoaPods download cache, the npm cache.

Third run: **BUILD SUCCESSFUL in 50s**, `app-debug.apk` (129 MB debug) produced.

Phase 0 done: both platforms build clean from a fresh prebuild.

### Screenshots needed (running list)

- [x] Phase 1: lock-screen card (simulator)
- [x] Phase 1: Dynamic Island compact
- [x] Phase 1: Dynamic Island expanded (long-press)
- [x] Phase 2/3: mid-flow status change (before/after Advance step)
- [x] Phase 3: rider reassignment state
- [ ] Phase 4: push-driven update with app closed (physical iPhone)
- [x] A2: Android notification shade with ProgressStyle segmented bar
- [x] A3: Android status-bar chip + lock-screen promoted placement

---

## 2026-07-08 (later) — Emulator rescue + Phase 1a: the native module

### Android emulator, finally alive

The API 36 system-image installs kept failing (`Not in GZIP format`) and then flat-out
hanging — sdkmanager sat 45 minutes on a dead socket writing zero bytes. Gave up on it and
did what sdkmanager does, by hand:

```bash
curl -fL --retry 10 -C - -o sysimg.zip \
  "https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-36_r07.zip"
unzip sysimg.zip -d $ANDROID_HOME/system-images/android-36/google_apis/
# + hand-write package.xml so Android Studio sees it as installed
```

Same file, same network: **1.7 GB in 58 seconds.** The `s25` AVD then booted headless to
`sys.boot_completed=1` in ~25s. Emulator unblocked.

### Phase 1a — `droptrack-live`, the custom Expo module

Scaffolded with `npx create-expo-module@latest --local` (SDK 57 template), then replaced the
template with the real thing. The module is the article's spine — one JS API, two native
implementations:

```
modules/droptrack-live/
├── expo-module.config.json   ← autolinking manifest (apple + android)
├── index.ts                  ← public JS API the app imports
├── src/                      ← types + native-module binding + web no-op
├── ios/
│   ├── DeliveryAttributes.swift   ← the Live Activity "contract" (static attrs + ContentState)
│   └── DroptrackLiveModule.swift  ← ActivityKit bridge: start/update/endDelivery
└── android/…                  ← isSupported=false stub until Phase 2a
```

API surface: `isSupported()`, `areActivitiesEnabled()`, `startDelivery(info, state) → id`,
`updateDelivery(id, state)`, `endDelivery(id, state, dismissAfterSeconds?)`.

Design notes worth keeping:
- **`DeliveryAttributes` is split in two on purpose** — static attributes (courier, order id)
  vs `ContentState` (status, progress, ETA, stops left). ActivityKit only lets the dynamic
  half change; the split is enforced by the type system, not convention.
- **Records over dictionaries** — Expo's `Record`/`@Field` validates the JS payload shape
  before Swift code runs; bad payloads fail loudly at the bridge.
- **Dates cross the bridge as epoch millis** (`etaEpochMillis`), converted to `Date` on the
  Swift side. Bridging real Date objects is where cross-platform modules go to die.
- **Activities are looked up by id on every call** (`Activity<DeliveryAttributes>.activities`)
  instead of cached in a property — ActivityKit owns the handles, so this survives JS reloads
  during development.
- **`pushType: nil`** for now — local updates only; APNs push updates are the stretch phase.

---

## 2026-07-08 (later still) — Phase 1b: the widget extension + dev console

### The Live Activity UI (targets/widgets/)

Added the widget extension with `@bacons/apple-targets` — a `targets/widgets/` folder with an
`expo-target.config.js` (type: widget, bundle id `.widgets` → com.fasarticle.droptrack.widgets,
App Group entitlement) and three Swift files:

- `index.swift` — `@main` WidgetBundle entry point
- `DeliveryAttributes.swift` — **exact copy** of the module's contract file (see gotcha)
- `DeliveryLiveActivity.swift` — `ActivityConfiguration` with all four presentations:
  lock-screen card, Dynamic Island expanded (4 regions), compact (icon + live %), minimal

Prebuild generates the Xcode target from the folder — the extension survives
`prebuild --clean` because its source of truth lives outside `ios/`.

Hit one snag: `prebuild --clean` died with ENOTEMPTY deleting the old `ios/` (race while
removing the prebuilt React xcframework). `rm -rf ios && npx expo prebuild -p ios` recovered.

### The dev console (App.tsx)

Replaced the template with a control panel: scripted 7-step delivery, each step a **complete
state snapshot** (status, progress, stops, ETA) — the same shape a backend would push. Controls:
start / next step / tap-a-dot to jump / restart / deliver now / cancel / auto-simulate (5s per
step). Also surfaces `isSupported` + `areActivitiesEnabled` + the live activity id.

Decision: **Expo API routes deferred to the push phase.** Local activity control talks straight
to the native module — a server only earns its keep when APNs enters (it will hold the push
token registry + the APNs sender; API routes are a good fit there).

Both platforms still compile; widget `.appex` confirmed embedded in the app bundle.

---

## 2026-07-08 (afternoon) — Phase 1c: it renders. All of it.

Captured on the iPhone 16 Pro simulator (iOS 18.0):

- `phase1-dev-console.png` — the control panel driving the activity
- `phase1-lockscreen-card.png` — lock-screen card: brand row, status headline,
  progress bar, courier + stops + live ETA
- `phase1-island-compact.png` — island pill: bicycle left of cutout, live % right
- `phase1-island-expanded.png` — long-press: all four regions (leading icon,
  trailing ETA, center status, bottom progress + courier row)

### The debugging story (article gold)

First test looked broken: activity running, island blank. One hour of diagnostics later —
appex present ✔, installed ✔, pluginkit-registered ✔, no crashes ✔ — the cause was
embarrassingly simple: **the running activity had been started by the morning's build, which
predated the widget extension.** A Live Activity binds to the app build that started it;
add the extension, and old activities still render nothing, forever. Fresh activity → perfect
rendering. Rule: after adding/changing the widget extension, kill and restart your activities.

Two more findings along the way:
- **Your own compact island UI never shows while your app is foreground** — leave the app
  (or lock) to see it. Don't debug "missing island" from inside your own app.
- **`simctl push` with a live-activity `start` event silently did nothing** — zero
  `liveactivitiesd` log entries. Push-to-start payload routing in the simulator needs its own
  investigation come the APNs phase.
- Bonus sim quirk: screenshots came back with a frozen clock (stale framebuffer) until the
  device was shut down and re-booted. When screenshots look impossible, reboot the sim.

Remaining for 1c: physical iPhone 13 Pro run (lock-screen only, no island) — deferred until
we next touch signing.

---

## 2026-07-08 (evening) — A1/A2: the Android side, verified end-to-end

(Note for the record: a chunk of the Kotlin implementation was written in an earlier session
that ended before anything was compiled or tested — this entry covers the formal Notifee
evaluation we promised at Phase 0, the API verification that forced a rewrite, and the first
real runs.)

### 📝 ARTICLE — Notifee evaluation: the off-the-shelf option is a dead end

Phase 0 predicted Notifee wouldn't expose `ProgressStyle` or promotion. The reality is
stronger than that:

- **The repo (invertase/notifee) was archived — read-only — on April 7, 2026.** Last npm
  release: 9.1.8, December 2024. The README now recommends `expo-notifications` or the
  community fork `react-native-notify-kit`.
- Zero occurrences of `ProgressStyle`, `setShortCriticalText`, `requestPromotedOngoing`, or
  `POST_PROMOTED_NOTIFICATIONS` anywhere in its source. Progress = classic
  `setProgress(max, current, indeterminate)` only.
- It builds with **compileSdk 34 / targetSdk 33** — it cannot even reference API 36 symbols.
- The notify-kit fork hasn't touched Android 16 Live Updates either (docs stop at API 35).

So for Android 16 Live Updates in React Native, a custom native module isn't just the
flexible choice — in July 2026 it's the *only* choice. Good news for the article's thesis.

### 📝 ARTICLE — API verification: the 36 vs 36.1 trap

Verified the entire Live Updates surface against developer.android.com, and it reshaped the
implementation. The critical, easy-to-miss fact: **Android 16 is two different releases.**

- **Base Android 16 (API 36, June 2025)**: has `Notification.ProgressStyle` (segments,
  points, tracker icon), `hasPromotableCharacteristics()`, `canPostPromotedNotifications()`,
  `FLAG_PROMOTED_ONGOING`. But NOT the promotion-request APIs.
- **Android 16 QPR (SDK "36.1", the minor-version SDK)**: adds
  `Notification.Builder.setRequestPromotedOngoing()`, `setShortCriticalText()`, and the
  `POST_PROMOTED_NOTIFICATIONS` permission. The status-bar-chip UI itself shipped with QPR1
  on Pixel (Sept 2025). Samsung One UI 8 feeds these into the Now Bar.
- Both report `Build.VERSION.SDK_INT == 36` — QPR is distinguishable only via
  `getprop ro.build.version.sdk_full` (36.1) / `SDK_INT_FULL`.

RN 0.86 compiles against **base** API 36 (`compileSdk = 36` in RN's version catalog), so the
previous session's platform-API code (`Notification.Builder.setRequestPromotedOngoing`)
would never have compiled. The fix that makes the whole mess disappear:
**`androidx.core:core-ktx:1.17.0`** — `NotificationCompat` gained `ProgressStyle`,
`setRequestPromotedOngoing` (sets the request extra, which QPR systems honor and everything
else ignores), and `setShortCriticalText` in 1.17.0. Rewrote the module on NotificationCompat:
no compileSdk bump, one code path, graceful degradation all the way down. Only the
*capability checks* stay behind `SDK_INT >= 36` guards — and `canPostPromotedNotifications()`
needs a `runCatching` because it's missing on pre-QPR 36 builds.

Kept one manual branch: below API 36, compat drops ProgressStyle **entirely** (no bar at
all), so pre-16 devices get the classic `setProgress(100, pct, false)` bar instead.

Also exposed `canPostPromotedNotifications()` to JS and added a "Live Updates promotion" row
to the dev console — promotion is all-or-nothing and silent when it fails, so surfacing the
OS's verdict directly in the app is the difference between debugging and guessing.

### Build + first run (base 36 emulator)

`assembleDebug`: **BUILD SUCCESSFUL in 28s**, first try. (Pre-flight: disk was at 100% /
3.4 GB free again — cleared ~14 GB of *other* Gradle versions' caches (`~/.gradle/caches/8.9`
etc., regenerable) + CocoaPods/Xcode module caches. The project's own `9.3.1` cache and
`modules-2` downloads stayed.)

On the existing `s25` AVD (build BE2A.250530.026 — **base** 16, pre-QPR):

- Notification posts with `android.template=Notification$ProgressStyle` (visible in
  `dumpsys notification --noredact`) — the compat class maps straight onto the platform style.
- **The segmented bar renders**: orange brand segment, truck tracker icon riding the
  progress position, milestone `Point` at 35%, future `setWhen` as "in 24m" in the header.
  Captured `a2-shade-progressstyle-base36.png` + `-midflow.png`.
- `hasPromotableCharacteristics=false` — as expected on pre-QPR: no chip, no lock-screen
  promotion, and that's exactly what a Pixel that hasn't taken the QPR update would show.

### The QPR emulator (A3 unlocked)

No QPR AVD existed. sdkmanager burned us last time, so straight to the playbook: curl'd
`sys-img/google_apis/arm64-v8a-36.1_r04.zip` (2 GB in ~1 min), unzipped into
`system-images/android-36.1/google_apis/`, hand-wrote `package.xml`. Homebrew's `avdmanager`
refused to see it (it pins its own SDK root via `toolsdir`), so hand-cloned the AVD too:
copied `~/.android/avd/s25.avd/config.ini` → `s25-qpr.avd/`, pointed `image.sysdir.1` at the
36.1 image. Booted clean. `ro.build.version.sdk_full=36.1`, build BE4B.251210.005 (Dec 2025).

Same APK, no rebuild:

- **`hasPromotableCharacteristics=true`**, `canPostPromotedNotifications()=true`, dev console
  row flips to yes.
- **Status-bar chip**: truck icon + "55%" pill in the top-left corner, from
  `setShortCriticalText`. Captured `a3-statusbar-chip.png`.
- **Lock screen**: the delivery gets its own prominent card — full segmented bar, tracker,
  ETA header. Captured `a3-lockscreen-promoted.png`. (Emulator gotcha: the AVD had the
  keyguard disabled, so sleep/wake kept landing on the home screen —
  `adb shell locksettings set-disabled false` brought the lock screen back.)

One APK, two Android 16 builds: identical code degrades from chip + lock-screen card + fancy
bar (QPR) → fancy bar only (base 36) → plain bar (pre-16). That's the comparison-chapter
money shot.

### Screenshots captured this session

- `a2-dev-console-android.png` — console with the promotion row
- `a2-shade-progressstyle-base36.png`, `a2-shade-progressstyle-midflow.png`
- `a3-statusbar-chip.png`, `a3-lockscreen-promoted.png`

---

## 2026-07-08 (night) — Phase 2/3 on the simulator: reassignment verified, and a scriptable sim

(Session note: the previous session wrote all six layers of the courierName→ContentState
move — Swift attributes ×2, widget UI, Swift bridge, TS types, Kotlin, App.tsx — type-checked
it, kicked off the iOS build… and hit the org spend limit the second the build finished.
This session picked up from the built-but-never-installed app.)

### 📝 ARTICLE — driving the iOS simulator without hands

Android gives you `uiautomator` + `input tap`; the iOS simulator gives you *nothing* —
no scriptable tap, and macOS accessibility permissions block synthetic clicks. The
workaround that made this session autonomous: a **dev-only deep-link driver** in App.tsx.
Expo registers the bundle id as a URL scheme by default, so
`simctl openurl booted com.fasarticle.droptrack://drive/<start|next|reassign|deliver|cancel>`
fires a `Linking` listener that calls the same handlers as the buttons. ~15 lines, `__DEV__`
only. One wrinkle: `openurl` *foregrounds the app*, and the compact island never renders
while the owning app is foreground — so every island capture is
drive-action → openurl Safari → screenshot.

### The trap of the day: reinstall wedges chronod

First activity after `simctl install` of the new build started fine at the ActivityKit
layer but rendered **nothing** — no island, no lock card. Logs told the story:
`chronod` (the widget-platter host) hit `widgetDescriptorNotFound(target:
com.fasarticle.droptrack, foundDescriptors: [])` at activity-start, its descriptor-retry
didn't re-attach the already-running activity, and the daemon was spewing XPC assertion
failures. `pluginkit` showed the extension registered — chronod itself was wedged.
End-the-activity-and-restart didn't fix it; **`simctl shutdown && boot` + a fresh activity
did.** (Playbook rule #1 has a sibling: it's not just *stale activities* that bind to dead
state — a stale *widget-host daemon* does too.)

### Phase 2/3 verified end-to-end

- **Mid-flow updates**: compact island ticked 55% → 70% live while the app sat in the
  background. Captured `phase2-island-midflow-before.png` / `-after.png`.
- **Rider reassignment**: `drive/reassign` swapped Ade → Tunde with the 🔄 badge, same step,
  in-place update on the same activity id. Console captured (`phase3-console-reassigned.png`).
- **Fast Refresh bonus**: a module-level App.tsx edit (LogBox suppression) hot-applied
  *without* losing `activityId` — the activity stayed bound. Don't count on it: a full JS
  reload orphans the activity (the module's fresh `Activity.activities` lookup by id is the
  only recovery path; an `endAll` dev helper is a good future addition).

The two human-input shots landed right after (user drove ⌘L + long-press, agent drove
state + screenshots — a nice split of labor): `phase3-lockscreen-reassigned.png` (lock card,
"New rider · Chioma", live ETA — first take had a stale ETA from the parked state, so we
re-fired a reassign to refresh it before the final capture) and
`phase3-island-expanded-reassigned.png` (expanded island: leading bike, center status,
trailing ETA, bottom row with the orange 🔄 courier treatment). **Phase 2/3 fully done —
the iOS local story is complete.** Design note for the article: at step 5 the center status
text and the stops label both say "2 stops away"; a real app would vary one.
