# ARTICLE NOTES — organized by likely article sections

Best explanations + code snippets get pulled here from the devlog as we go.

## 1. What a Live Activity is (and why it's not a push notification)

- Persistent, glanceable, self-updating card on the lock screen + Dynamic Island.
- Not a notification: it has *state* that updates in place, a bounded lifetime (max ~8h live,
  ~12h on lock screen), and dedicated system surfaces.
- Timeline: iOS 16.1 (lock screen) → 16.2 (Dynamic Island) → 17.2 (push-to-start) →
  18 (broadcast channels).

## 2. The three-part architecture (iOS)

1. **Widget Extension** (WidgetKit + SwiftUI) — renders the card. Separate target; no JS here.
2. **Native module** — the JS ⇄ ActivityKit bridge (start/update/end from React Native).
3. **APNs push updates** — per-activity push token; backend updates the card while the app is
   closed.

## 3. The RN-specific setup

- Expo managed + prebuild; `@bacons/apple-targets` generates the widget extension target from
  a config file so it survives `prebuild --clean`.
- Versions used: Expo SDK 57.0.4, RN 0.86.0, React 19.2.3, Xcode 26.3, macOS 26.1.
- 📝 Decision: custom Expo native module over `expo-live-activity` package — the package's
  fixed layout/state shape can't express a custom progress bar or reassignment flow.
  (Full tradeoff note in DEVLOG 2026-07-08.)

## 4. The SwiftUI UI (incl. the segmented progress bar)

- (Phase 1: ActivityAttributes/ContentState definitions, the capsule HStack bar, lock-screen
  layout, Dynamic Island compact/minimal/expanded.)

## 5. Driving it from JS

- (Phase 2: the Expo module API, event flow, authorization checks.)
- **The attributes-vs-state bet (Phase 2/3, 2026-07-08):** `ActivityAttributes` is a
  contract — static attrs are a bet that a field can *never* change for the activity's
  lifetime. `courierName` started static; the rider-reassignment feature proved couriers do
  change mid-delivery, and the fix touched all six layers (Swift attrs ×2 — app + widget
  copies must stay identical, widget UI, Swift bridge records, TS types, Kotlin records,
  app code). Lose the bet, move the whole contract. Only `orderId` survived as truly static.
- Reassignment as in-place update: same activity id, same step, new `courierName` +
  `riderReassigned: true` → the card flips to an orange "New rider · Tunde" treatment.
  Advancing a step retires the badge. Verified live: island ticked 55% → 70% with the app
  backgrounded, then the swap landed on the same activity.
- **Sidebar candidate — scripting the unscriptable simulator:** dev-only deep-link driver
  (`Linking` listener + `simctl openurl booted <bundle-id>://drive/<action>`) because iOS
  sims have no `input tap`. ~15 lines, `__DEV__` only. Pairs with the Android
  `uiautomator dump` + `input tap` flow from A2 for a nice cross-platform testing aside.
- Screenshots: phase2-island-midflow-before/-after (55%→70% compact island),
  phase3-console-reassigned (+ pending: lock card & expanded island of the reassign state).

## 6. The push-update pipeline

- (Phase 4: push token capture, APNs JWT, `apns-topic: <bundle>.push-type.liveactivity`,
  payload shape must match ContentState exactly, ~4 KB limit.)

## 6.5 The Android implementation (A1/A2, 2026-07-08)

- Notifee is archived (April 2026) with zero Live Updates support and compileSdk 34 — as of
  mid-2026 a custom module is the ONLY React Native route to Android 16 Live Updates.
- "Android 16" is two releases: base API 36 has ProgressStyle; promotion request APIs +
  POST_PROMOTED_NOTIFICATIONS are SDK 36.1 (QPR, chip UI shipped Pixel Sept 2025). Both say
  SDK_INT=36. RN 0.86 compiles against base 36 → use androidx.core 1.17's NotificationCompat
  backports (ProgressStyle, setRequestPromotedOngoing, setShortCriticalText).
- No ActivityKit on Android: "the activity" is a notification re-posted under a stable ID.
  start/update/end map to notify()/notify()/notify(ongoing=false) + delayed cancel().
- Promotion eligibility is all-or-nothing + silent: permission, request, ongoing, title,
  allowed style, importance > MIN, not colorized. Debug via hasPromotableCharacteristics()
  logging + canPostPromotedNotifications() surfaced in the dev console.
- Degradation ladder (same APK, verified on two emulators): QPR → chip + lock-screen card +
  segmented bar; base 36 → segmented bar only, no promotion; pre-16 → classic setProgress
  bar (compat drops ProgressStyle entirely, so keep the manual branch).
- Screenshots: a2-dev-console-android, a2-shade-progressstyle-base36 + -midflow,
  a3-statusbar-chip, a3-lockscreen-promoted.

## 7. iOS vs. Android — the comparison chapter

| | iOS Live Activity | Android Live Update |
|---|---|---|
| Introduced | iOS 16.1/16.2 | Android 16 (API 36) |
| UI | Custom SwiftUI in a separate widget extension | System `ProgressStyle` template on an ongoing notification — custom RemoteViews **not allowed** for promoted notifications |
| Surfaces | Lock screen + Dynamic Island | Shade + status-bar chip + promoted lock-screen slot (+ AOD) |
| Update while app closed | Dedicated per-activity APNs push token, `liveactivity` push type | Re-post same notification ID from a foreground service/WorkManager; remote = plain FCM data message that wakes the app |
| Progress bar | Hand-built (HStack of capsules) | `ProgressStyle` segments + points (per-segment colors, milestone icons) |
| Promotion rules | Automatic once started | Must satisfy characteristics: permission, `setRequestPromotedOngoing(true)`, ongoing, title, allowed style, importance > MIN, not colorized |

- (A1–A5 fill this out with real code + screenshots.)

## 8. Gotchas

- (Curated from GOTCHAS.md at Phase 5.)
