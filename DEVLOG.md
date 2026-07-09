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
- [x] Phase 1: Dynamic Island compact (also real hardware — hero-island-compact.png)
- [x] Phase 1: Dynamic Island expanded (long-press) (also real hardware — hero-island-expanded.png)
- [x] Phase 2/3: mid-flow status change (before/after Advance step)
- [x] Phase 3: rider reassignment state
- [x] Phase 4: push-driven update with app closed (physical iPhone) — done in TSK-3
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

---

## 2026-07-09 — A5: Samsung, hands-on after all (Remote Test Lab)

Plan A (research-only) got upgraded: Samsung's **Remote Test Lab** gave us a real
**Galaxy S25 Ultra (SM-S938N, Korea)** in the browser, and its **Remote Debug Bridge**
turned out to be a local adb tunnel — download a binary, run it, click the RTL sidebar
button, and `adb devices` shows the remote phone (`localhost:<port>`). From there the whole
emulator playbook worked over the Pacific: `pm grant`, `input tap`, `screencap`, `dumpsys`.
(Two rdb traps: it's an x86_64 binary — Rosetta, slow first launch; it ignores CLI args and
just starts its server, and TWO instances fight over the web client — run exactly one.
Also: 25 MB arm64-only release APK via `-PreactNativeArchitectures=arm64-v8a`, since a
remote device can't reach Metro.)

### 📝 ARTICLE — the Samsung findings (the OEM chapter writes itself)

1. **Samsung's "Android 16" is base API 36, not the QPR.** `ro.build.version.sdk_full=36.0`,
   One UI 8.0, build BP2A.250605.031.A3 (June 2025 base). Everything we learned about the
   36 vs 36.1 split applies to real flagship hardware in July 2026: the promotion-request
   pipeline simply does not exist on a Galaxy S25 Ultra.
2. **`canPostPromotedNotifications()` → false** (console row: "Live Updates promotion: no"),
   **but `hasPromotableCharacteristics()` → TRUE** — on the base-36 Pixel emulator the same
   APK returned false. Samsung has backported enough of the promotion framework to
   recognize the request extra, without shipping the user-facing pipeline. Same version
   number, three different answers across three devices.
3. **ProgressStyle renders, Samsung-styled**: orange bar, tracker truck riding at 55%, the
   35% milestone Point drawn as a square notch (Pixel: dot), and the future `setWhen`
   rendered as absolute "2:46 PM" (Pixel: relative "in 24m").
4. **No promoted surfaces anywhere**: no status-bar chip (just the classic small icon), no
   lock-screen card (icon row only — and NOT a config issue: per-app settings show Lock
   screen ✓ + "Show always"), and **no Now Bar pickup**.
5. **The Now Bar is a partner allowlist, not a pipeline.** Samsung's system settings table
   has per-app keys — `key_now_bar_com_nhn_android_search=1`,
   `support_nowbar_naver_sports=1` (Naver = Korean partner). Writing
   `key_now_bar_com_fasarticle_droptrack=1` and re-posting did nothing — enforcement lives
   in Samsung's service, not the key. One UI 8.0's per-app notification settings expose no
   "Live updates" toggle for third parties at all.

Bottom line for the article: in mid-2026, "Android 16 Live Updates" on the best-selling
Android flagship means *a nicely restyled ordinary notification*. The chip + lock-screen
promotion story is Pixel-QPR-only until Samsung takes the 36.1 update; Now Bar access is
business development, not an API.

### Screenshots

- `a5-console-s25ultra-promotion-no.png` — the console verdict on real hardware
- `a5-shade-s25ultra.png` — ProgressStyle in One UI clothing (square milestone, tracker)
- `a5-lockscreen-s25ultra.png` — no card, no Now Bar; status-bar truck icon only
- `a5-oneui-notif-settings.png` — One UI per-app page: no Live updates surface

---

## 2026-07-09 (later) — A5 part 2: the S26 Ultra rewrites the Samsung conclusion

User spotted Samsung marketing about the Now Bar on newer devices, so we ran a second RTL
session on a **Galaxy S26 Ultra (SM-S947U)**. Worth every credit — the story flipped:

- **`sdk_full=36.1`, One UI 8.5** (build BP4A.251205.006, Dec 2025). Samsung DID take the
  QPR — one hardware generation after Google shipped it.
- **`canPostPromotedNotifications()=true`** — the dev-console row flips to yes. Same APK.
- **The OS grants the promotion for real**: `dumpsys notification` shows our notification
  carrying **`FLAG_PROMOTED_ONGOING`** — a third-party app, no partnership, no allowlist key.
- Promoted *effects* visible: pinned to the top of the shade, truck small-icon in the
  status bar. ProgressStyle renders in the same One UI style as 8.0 (square milestone notch).
- **But no Pixel-style chip pill, no lock-screen card, and the Now Bar never picked up our
  delivery** — it showed only Samsung's own "Now brief" throughout (tap, swipe, fresh-update-
  then-lock all tried). And One UI 8.5's per-app notification settings STILL have no "Live
  updates" toggle. So the framework promotion is granted, but Samsung's flagship promoted
  surface stays curated. Caveat for the article: RTL units are managed devices ("belongs to
  your organization") and we couldn't rule out policy/regional factors — frame as "in our
  testing" rather than absolute.

The three-generation arc for the OEM chapter: **S25 (One UI 8.0) = pipeline absent →
S26 (One UI 8.5) = pipeline present, promotion granted, but the Now Bar still doesn't
surface third-party Live Updates → the open question is whether Samsung ever will.**
Meanwhile the same APK on a QPR Pixel gets chip + lock-screen card automatically. That
contrast — Apple: public API; Google: public API on its own hardware; Samsung: framework
yes, flagship surface curated — is the article's sharpest paragraph.

RTL automation notes: the second session's device came up in **landscape**, which silently
broke every tap computed from portrait screenshots (the misdirected taps opened Galaxy AI
onboarding) — check `wm size`/orientation before driving, `settings put system
user_rotation 0` to force portrait. RTL lock screens also aggressively doze: `svc power
stayon true` before lock-screen work.

### Screenshots

- `a5-console-s26ultra-promotion-yes.png` — the row flips to yes on 36.1
- `a5-shade-s26ultra.png` — promoted ordering: pinned top-of-shade, ProgressStyle bar
- `a5-lockscreen-s26ultra.png` — Now Bar present but showing only Samsung's "Now brief"
- `a5-nowbar-settings-s26.png`, `a5-oneui85-notif-settings.png` — settings surfaces

---

## 2026-07-09 (evening) — A5 part 3: the mid-ranger and the smoking gun

Third RTL session, **Galaxy A37 5G (SM-A376E)** — the "where most Samsung users live" data
point. Same One UI 8.5 / `sdk_full=36.1` as the S26 Ultra (mid-rangers get 8.5 too), and
the same split verdict: console "promotion: yes", **`FLAG_PROMOTED_ONGOING` granted** to
our APK, truck in the status bar — but nothing on the lock screen. (This stripped RTL unit
has no Samsung account and no Clock app, so no Now Brief pill and no timer control test.)

### The smoking gun: Samsung's own "Live notifications" settings page

Searching Settings for "live notification" (a search "Now bar" doesn't surface!) found
**Lock screen and AOD → Live notifications** on One UI 8.5:

- The page description promises exactly the three promoted surfaces: *"Live notifications
  will appear on the Lock screen, on the status bar, and at the top of the notification
  panel"* — with an illustration of the Now Bar pill, status chip, and top-of-panel card.
- Below it: a **fixed six-entry allowlist** — Audio broadcast, Emergency sharing, Google
  Finance, Maps, Media player, Sports from Google. Per-app toggles. **DropTrack is not in
  the list** — while its PROMOTED_ONGOING delivery is live that very second.
- The "Not seeing Live notifications?" tip claims the criteria are just notification
  permissions (allow + lock screen + show content) — **all three of which our app has**.
  Samsung's stated criteria are satisfied; the list is curated beyond them.

So the One UI 8.5 conclusion is now airtight and quotable: the OS grants Google's promotion
flag to any third-party app, delivers the top-of-shade + status-bar-icon parts, and
reserves the headline surfaces (lock screen / Now Bar) for a hardcoded list of Google and
Samsung integrations. Two devices (flagship + mid-range), same behavior, and the settings
UI itself documents the gap between promise and list.

### Screenshots

- `a5-console-a37-promotion-yes.png`, `a5-lockscreen-a37.png` (no pill at all — no Samsung
  account on this unit)
- `a5-live-notifications-settings-a37.png` — THE shot: the promise, the illustration, the
  six-app list, no DropTrack
- `a5-live-notifications-list-a37.png`, `a5-live-notif-tip-a37.png` — the criteria tip

---

## 2026-07-09 (later) — TSK-3: APNs push-driven updates, on a real iPhone 14 Pro

The last unproven claim in the iOS half of the article: **a server can drive the Live
Activity while the app is not running at all.** Everything before this was ActivityKit
calling itself from inside our own process. Verified today on Damisa's iPhone 14 Pro
(iOS 26.5), with the DropTrack process confirmed dead.

### The three-line change that makes it possible

`pushType: nil` → `pushType: .token` in `Activity.request`. That's the entire API surface.
Everything else is plumbing:

- APNs mints a token **per activity**, not per device — and it arrives *asynchronously,
  after* `request()` returns. Reading `activity.pushToken` immediately gives nil. The
  correct consumer is `for await token in activity.pushTokenUpdates`, an `AsyncSequence`
  that also re-fires whenever the system rotates the token. We forward each one to JS as an
  `onPushTokenReceived` event (plus an `NSLog`, see below).
- The app needs the **`aps-environment` entitlement**. Without it, `Activity.request`
  succeeds, the activity runs fine on local updates, and `pushTokenUpdates` simply never
  yields. No error, no log. Added to `ios.entitlements` in `app.json`.

### `scripts/push-update.mjs` — a dependency-free APNs client

Zero npm deps: ES256 JWT via `node:crypto`, HTTP/2 via `node:http2` (APNs speaks HTTP/2
only — `fetch()` cannot reach it). Two traps worth the article's ink:

- `crypto.sign` emits **DER** by default; JOSE wants raw r‖s. Without
  `dsaEncoding: 'ieee-p1363'` the JWT is well-formed and simply never authenticates.
- The topic is `<bundle-id>.push-type.liveactivity`, not the bundle id, with
  `apns-push-type: liveactivity`.

**The debugging trick that saved the session:** before touching a device, push to the
sandbox with a *fake* device token. `400 BadDeviceToken` proves the `.p8`, key id, team id
and JWT are all correct — APNs got far enough to look the token up and not find it.
`403 InvalidProviderToken` would mean the key is wrong. That splits "my auth is broken"
from "my token is broken" with zero device involvement, and it's the first thing I'd tell
anyone wiring up APNs.

### Getting a token off a wired-only iPhone

Two device-harness facts, both new:

1. **A Debug build on a wired-only phone can't reach Metro.** `react-native-xcode.sh` bakes
   the Mac's *LAN* IP into `ip.txt` inside the .app. Phone not on that Wi-Fi ⇒
   `No script URL provided … unsanitizedScriptURLString = (null)`. iOS has no `adb reverse`.
   Fix: `--configuration Release`, which embeds `main.jsbundle` — and which is the *more
   honest* harness for this test anyway, because the app can then be fully force-quit with
   no Metro socket keeping anything alive.
2. **`__DEV__` is false in Release, so the deep-link test driver is stripped.** The
   simulator trick (`simctl openurl` → `Linking` `'url'` event) doesn't port either:
   `devicectl process launch --payload-url` *cold-starts* the app, so the URL arrives via
   `Linking.getInitialURL()` and the `'url'` event never fires. Handled both; the Release
   run still needed one human tap on Start.

Because RN's `console.log` goes to Metro and there was no Metro, the push token is also
written with `NSLog`, which `xcrun devicectl device process launch --console` streams back
over the wire. That's how the token was captured.

### The result

Activity `3095ACA0…`, token `80875cb1…` (160 hex chars). Then, with `devicectl device info
processes` confirming **DropTrack's own pid was gone** (only `DropTrackWidgets.appex` and
the system's `liveactivitiesd` alive):

| Push | `content-state` | APNs |
|------|-----------------|------|
| step 4 | "2 stops away", Ade | 200 |
| step 5 | "Next stop: you", **Tunde**, `riderReassigned: true` | 200 |
| step 6 | "Arriving now 🛵", 0 stops, 95% | 200 |

Lock screen and Dynamic Island tracked every one. Rider reassignment — the state that forced
`courierName` out of the static attributes back in Phase 2 — round-trips through APNs intact.

**200 from APNs is not proof of anything on the device.** A `content-state` whose shape
doesn't decode into the widget's `ContentState` is dropped *silently* by iOS: no error, no
log, the card just keeps showing the old state. The 200 only says Apple accepted the bytes.
The verification is eyes on the lock screen, every time. (`aps.timestamp` is likewise a
silent ordering guard — an older timestamp than the last applied update is discarded.)

Also confirmed: Swift `Date` in the payload decodes as **seconds since 2001**, not the Unix
epoch (`APPLE_EPOCH_OFFSET = 978_307_200`). A raw `Date.now()/1000` puts the ETA in 2057.

### Screenshots needed (running list)

- [x] Phase 4 / TSK-3: push-driven update with app closed (physical iPhone 14 Pro)
- [ ] TSK-4: Dynamic Island compact + expanded on real hardware (activity left running)

### Postscript: tapping the card lands you in an app with amnesia

Immediately after the push test, a real bug surfaced by using the thing like a user: **tap
the Dynamic Island or the lock-screen card, and the app opens on "Not tracking" with every
control disabled** — while the card is still visibly on screen.

Nothing was broken on the device. Live Activities are owned by the system, not by our
process; they survive force-quit and relaunch. What died was React state. `activityId` lived
only in `useState`, and the launch that the *user triggered by tapping the card* is a cold
start. The app therefore had no handle on an activity that was running perfectly well —
`Activity.activities` still listed it, and an APNs push still returned 200 (a dead activity
returns 410, which is how we proved it was alive before changing a line).

The fix is to treat the system as the source of truth on launch: a new
`getRunningActivities()` enumerates `Activity<DeliveryAttributes>.activities`, and App.tsx
re-attaches on mount — recovering the courier, the reassignment flag, the push token, and
the current step by matching `activity.content.state.status` back onto `STEPS`. While there,
we re-subscribe to `pushTokenUpdates`: the previous process's `for await` loop died with it,
so a token rotation after relaunch would otherwise go unnoticed. Also added `endAll()`, the
dev helper the simulator playbook has wanted since Phase 2.

Verified the way it should be: started a fresh activity (new id `A129AA87…`, and note a
**brand-new token** `800ed06c…` — per-activity, exactly as advertised), pushed it to
"2 stops away" over APNs, killed the app process, and cold-started it. The re-subscribe
fired on launch and APNs re-issued the same token against the recovered activity. The
console came back attached instead of amnesiac.

Worth its own paragraph in the article: the API hands you an `activityId` and it is very
easy to assume that id is yours to keep. It isn't. The activity outlives the variable, and
the one moment your user is most likely to open the app — tapping the live card — is
precisely the moment your in-memory copy of that id doesn't exist.

---

## 2026-07-09 (later) — The dispatcher portal: driving the phone from a browser

Copying a 160-character hex token out of a terminal to run a CLI got old fast. Built an
Expo **web** dispatcher console that drives the phone's Live Activity from a browser — pick a
step, a courier, toggle a reassignment, click, and the lock-screen card changes with the app
force-quit. Spec + plan in `docs/superpowers/`.

### The shape of it, and why it isn't just a web page

A browser **cannot** talk to APNs: it's HTTP/2-only, exposes no CORS, and signing needs the
`.p8` private key, which must never reach a web page. So the portal is two pieces:

```
iPhone ──NSLog──> devicectl --console ──scrape──> dispatch-server (127.0.0.1:8787)
                                                    │  registry: activityId → token
browser (expo web) <──SSE /events──────────────────┘
       └──POST /push──> dispatch-server ──ES256 JWT + HTTP/2──> APNs ──> widget
```

- `scripts/apns.mjs` — the signing + HTTP/2 core, extracted from `push-update.mjs` (which is
  now a thin CLI over it). One implementation, unit-tested: the JWT test asserts the
  signature is exactly 64 bytes, pinning the raw-r‖s-vs-DER gotcha.
- `scripts/dispatch-server.mjs` — zero-dependency Node server, binds `127.0.0.1` only. Spawns
  `devicectl … --console`, scrapes the `[DropTrack] push token …` NSLog line, and keeps a
  `Map<activityId, token>`. Streams tokens to the browser over SSE; signs and sends pushes on
  `POST /push`. The `.p8` never leaves the process — no route returns key material.
- `delivery.ts` — the delivery script (`STEPS`, `toDeliveryState`) extracted from `App.tsx` so
  the phone app and the web console run the identical script. That shared script is the whole
  reason this is Expo web and not a static HTML page.
- `DispatcherConsole.tsx` — the web UI (`App.tsx` renders it when `Platform.OS === 'web'`).

### The gotcha the build surfaced: two different "eta"s

The shared `toDeliveryState()` produces the **native-bridge** shape: `etaEpochMillis` in Unix
milliseconds, which the Swift `DeliveryStateRecord` converts to a `Date`. But an APNs push's
`content-state` is decoded **directly** by the widget's Codable `ContentState`, which expects
a field named `eta` in **seconds since 2001** and has no `etaEpochMillis`. Send the
native-bridge shape over APNs and you get the classic silent failure — APNs returns 200, iOS
drops the update, nothing logs. The fix lives in the server (`toContentState`), the one place
that is unambiguously the APNs boundary: it strips `etaEpochMillis` and emits Apple-epoch
`eta`. The CLI never hit this because it always built its own `eta` by hand.

### Verified

- The web bundle compiles and bundles under react-native-web (the full
  `App → DispatcherConsole → dispatchClient → delivery` chain).
- Browser-shaped push (a `DeliveryState` with `etaEpochMillis`, no `eta`) → server translates
  → APNs returns 400 BadDeviceToken for a fake token, i.e. the content-state structure is
  accepted; the translation works end-to-end.
- Opt-in `APNS_INTEGRATION=1` test proves the real key/team/kid authenticate (400, not 403).
- **Live device leg confirmed on the iPhone 13 Pro (wired):** the server scraped the token off
  the device console (activity `C44A2514…`, token `80028067…`), the browser console drove a
  push, and the lock-screen card updated. Two connection lessons: (1) `expo run:ios` wants the
  hardware UDID (`00008110-…`) while the dispatch server's `devicectl` wants the CoreDevice id
  (`76E675DA-…`) — different namespaces for the same phone; (2) a **wireless** device drops the
  `devicectl --console` session (`exited code 1`) mid-run, so token intake needs a **wired**
  connection. Release build required (embedded JS): a Debug build red-boxes with no Metro, and
  the app must run standalone anyway since the server cold-starts it.

### Compose-then-send

First pass fired a push the instant you clicked a step. Reworked to a three-step compose flow —
pick courier (+ optional reassignment), stage an update (step or "Delivered"), then press a
single **Send notification** button. Nothing hits APNs until that press. Screenshot:
`screenshots/tsk3-web-dispatcher.png`.

The portal is test tooling, not article evidence — it makes TSK-4/TSK-5 easier to drive.

---

## 2026-07-09 — TSK-4: hero shots on the iPhone 14 Pro (real Dynamic Island)

Forward-facing images for the top of the article, captured on Damisa's iPhone 14 Pro (iOS
26.5) driven from the web dispatcher into "2 stops away" (5/7 segments, courier Ade,
ETA 15:36). All three show the new segmented progress bar rendering identically across
surfaces:

- `screenshots/hero-island-expanded.png` — expanded Dynamic Island (long-press). The primary
  hero: bicycle, status, ETA, segmented bar, courier row. Most legible "this is a Live
  Activity" shot.
- `screenshots/hero-lockscreen.png` — lock-screen card, clean.
- `screenshots/hero-island-compact.png` — compact island pill (bicycle + 70%) over Safari,
  the glanceable state.

Suggested blog order: expanded island → lock-screen card → compact pill. (A fourth capture
caught iOS's periodic "Allow Live Activities?" confirmation over the card — discarded; the
lock-screen hero is the clean re-shoot.)

**Bonus surface — the Mac menu bar** (`screenshots/hero-mac-menubar.png`): with the same
Apple ID, the Live Activity surfaces on macOS's menu bar via Continuity, with **zero extra
code** — it's the same push-driven activity, and the 7-segment bar renders there too (shot
shows "Picked up your order" = 3/7). A nice "it follows you across devices" beat: one APNs
push, and the widget shows up on phone lock screen, Dynamic Island, and Mac.


---

## 2026-07-09 — TSK-5: Android FCM push-driven Live Updates (the asymmetry, proven)

The Android counterpart to TSK-3, and the more instructive half. **iOS:** APNs → the system →
the widget; app code never runs. **Android:** there is no system-managed remote update — a
data-only FCM message wakes a `FirebaseMessagingService` and OUR code re-posts the
notification. The app is the updater.

### Verified end-to-end on the s25 emulator (android-36 google_apis, has Play Services)

Started a delivery (local notification posts), pressed **Home** (app confirmed NOT foreground
via `dumpsys activity`), then sent a data-only FCM push from `fcm.mjs`. The notification
updated to the pushed state — `dumpsys notification` showed `android.title="2 stops away"`,
`android.text="Tunde · 2 stops away"`, and the shade rendered the ProgressStyle bar + truck
tracker at ~70% with the milestone point at 35%. Screenshot:
`screenshots/tsk5-android-fcm-push.png`. FCM returned 200; the service's `onMessageReceived`
ran in-process and re-posted. (Base 36 → no promotion surfaces, as expected; promotion itself
was established on Samsung One UI 8.5 in A5.)

### What shipped
- `DeliveryNotifier.kt` — notification builder extracted from the module so both the JS path
  and the FCM service post an identical Live Update from plain params.
- `DroptrackFcmService.kt` — `onMessageReceived` rebuilds from the data payload (it has no
  access to the module's in-memory map — separate entry point); `onNewToken` logs for the scrape.
- `getFcmToken()` / `onFcmTokenReceived` (JS + Kotlin), mirroring the iOS token API.
- `plugins/withAndroidFcm.js` — config plugin placing `google-services.json` + the
  `google-services` gradle wiring through CNG.
- `scripts/fcm.mjs` — zero-dep FCM HTTP v1 client (service-account RS256 JWT → OAuth token →
  send). The dispatch server now routes by platform and scrapes the FCM token from `adb logcat`;
  the web console has an iOS/Android toggle.

### Article beats
- **The push asymmetry** above — the single best iOS-vs-Android contrast in the piece.
- **Data vs notification messages:** only a data-only message routes to `onMessageReceived`
  when backgrounded; a `notification` message is swallowed by the system tray. High priority
  wakes it promptly.
- **Auth:** FCM v1 uses a service-account RS256 JWT exchanged for an OAuth token (heavier than
  APNs' `.p8` ES256). And FCM distinguishes a **malformed** token (`400 INVALID_ARGUMENT`)
  from an **unregistered** one (`404 UNREGISTERED`), where APNs returns a single
  `BadDeviceToken`.
- **Reliability gap:** data messages can be dropped under Doze or after a force-kill — unlike a
  system-owned iOS Live Activity. We test backgrounded (Home), not swiped-away, and document
  the gap rather than engineering around it.

### Screenshots
- `screenshots/tsk5-android-fcm-push.png` — the shade after a remote FCM push, app backgrounded.
