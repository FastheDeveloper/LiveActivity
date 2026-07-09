# TSK-5 — Android FCM push-driven Live Updates — design

**Date:** 2026-07-09
**Status:** approved, not yet implemented
**Context:** TSK-3 proved APNs can drive an iOS Live Activity with the app force-quit. This is
the Android counterpart: a remote FCM push that updates the Android 16 Live Update
notification without the app in the foreground. The Kotlin side of `droptrack-live` already
posts/updates the notification locally (A1–A3); FCM has never been set up.

## Goal

A data-only FCM push, sent from the (extended) dispatcher portal, updates the DropTrack Live
Update notification on an Android device while the app is backgrounded — mirroring how APNs
drove the iOS widget. Verified on an `google_apis` API 36 emulator; promoted surfaces
(status-bar chip, lock screen) verified on the Samsung One UI 8.5 device via RTL as an
optional hero (A5 already established promotion works there).

## The load-bearing asymmetry (the reason this is a whole task, not a payload tweak)

- **iOS:** APNs → the system → the widget. App code never runs.
- **Android:** there is no system-managed remote update. A data-only FCM message wakes a
  `FirebaseMessagingService`, and **our code re-posts the notification**. The app is the
  updater, even from the background.

Consequence: the service is a separate entry point from the module instance, so it **cannot**
use the module's in-memory `deliveries` map. The push payload must carry the full state, and
the notification is rebuilt from scratch on every message.

## External prerequisites (user-provided, gitignored)

1. A Firebase project with an Android app registered for `com.fasarticle.droptrack` →
   `google-services.json`.
2. A service-account private key JSON (Firebase console → Project settings → Service accounts
   → Generate new private key) for the FCM HTTP v1 sender.

Both are gitignored (add `google-services.json` and `*-service-account*.json` /
`service-account*.json` patterns). Never committed, mirroring the `.p8`.

## Message shape (constraint, not a choice)

- **Data-only** message (no `notification` block): only data messages route to
  `onMessageReceived` when the app is backgrounded/killed. A `notification` message is
  handled by the system tray and never reaches our code.
- **High priority** (`android.priority: "high"`): needed to wake the app promptly.
- Values are strings (FCM data is `map<string,string>`); the service parses types.
- **Reliability gap (documented, not fixed):** data messages are not guaranteed under Doze or
  after a force-kill — unlike an APNs-updated Live Activity, which the system owns. High
  priority mitigates. Test with the app backgrounded, not force-killed.

## Architecture

```
web console [Android] → POST /push {platform:'android'} → dispatch-server
   → fcm.mjs → FCM HTTP v1 → FCM → device Google Play Services
   → DroptrackFcmService.onMessageReceived → DeliveryNotifier.post(...)
   → NotificationManager.notify(sameId) → Live Update updates
```

Token intake: the app calls `getFcmToken()` and the module logs `[DropTrack] fcm token: <t>`;
the dispatch server scrapes it from `adb logcat` (the `adb` analog of the iOS `devicectl
--console` scrape) and registers it.

## Components

### Native — `modules/droptrack-live/android/`

1. **`DeliveryNotifier.kt`** (new) — the notification builder extracted from the module's
   current private `postDelivery`. Plain-typed params (`orderId, status, progress,
   etaEpochMillis, stopsRemaining, courierName, riderReassigned, ongoing`), no Expo Records.
   Owns `ensureChannel()`, `notificationIdFor()`, `courierLine()`, `stopsLabel()`, the
   `ProgressStyle`/promotion setup, and the `notify()` call. Callable from any entry point.
2. **`DroptrackLiveModule.kt`** (modified) — `startDelivery`/`updateDelivery`/`endDelivery`
   delegate to `DeliveryNotifier` instead of the inline body. Adds:
   - `getFcmToken()` → `Promise<String?>` (via `FirebaseMessaging.getInstance().token`).
   - `Events("onFcmTokenReceived")` + emits when the module observes a new token.
   - The in-memory `deliveries` map stays for the local (JS-driven) path only.
3. **`DroptrackFcmService.kt`** (new) — `extends FirebaseMessagingService`:
   - `onNewToken(token)`: `Log.i(TAG, "[DropTrack] fcm token: $token")` (for the scrape) and,
     if a React context is live, emit `onFcmTokenReceived`.
   - `onMessageReceived(msg)`: parse `msg.data`, call `DeliveryNotifier.post(...)` with
     `ongoing = (event != "end")`; on `event == "end"` optionally schedule a cancel.
   - Registered in the module's `AndroidManifest.xml` with the
     `com.google.firebase.MESSAGING_EVENT` intent filter.

### Config plugin — `plugins/withAndroidFcm.js` (new, app-level), referenced in `app.json`

Since `android/` is CNG/gitignored, a **local app-level config plugin** (a `plugins/withAndroidFcm.js`
file added to `app.json`'s `plugins` array, alongside `@bacons/apple-targets`) must, on prebuild:
- copy `google-services.json` (from the repo root or an env-pointed path) into `android/app/`,
- add the `com.google.gms:google-services` classpath to the project `build.gradle` and apply
  `com.google.gms.google-services` in `android/app/build.gradle`,
- add `com.google.firebase:firebase-messaging` via the Firebase BoM to app dependencies.

Rationale for app-level (not inside the module): `google-services.json` placement and the
root-project `google-services` classpath are app/project concerns, not module-local ones;
keeping them in one `app.json`-referenced plugin matches how `@bacons/apple-targets` is wired.
`google-services.json` itself lives gitignored at the repo root.

### Sender — `scripts/`

4. **`scripts/fcm.mjs`** (new, zero-dep) — FCM HTTP v1 client:
   - `mintAccessToken()`: RS256 JWT signed with the service-account private key (scope
     `https://www.googleapis.com/auth/firebase.messaging`), exchanged at
     `https://oauth2.googleapis.com/token` for a bearer token (cache until expiry).
   - `sendDataMessage({ token, data })`: `POST` to
     `https://fcm.googleapis.com/v1/projects/<projectId>/messages:send` with
     `{ message: { token, data, android: { priority: 'high' } } }`. Returns `{ status, reason }`
     (reason from the FCM error `status`, e.g. `UNREGISTERED`, `INVALID_ARGUMENT`).
   - Config from env: `FCM_SERVICE_ACCOUNT` (path), `FCM_PROJECT_ID` (or read from the
     service-account JSON's `project_id`).
5. **`scripts/dispatch-server.mjs`** (modified):
   - Registry entries gain a `platform` (`'ios'|'android'`). Two token sources: the existing
     `devicectl --console` scrape (iOS) and a new `adb logcat` scrape for
     `[DropTrack] fcm token:` (Android). Enable Android intake when `ADB_DEVICE`/an `adb`
     device is present.
   - `POST /push` body gains `platform`; routes to `apns.mjs` (existing `toContentState`
     translation) or `fcm.mjs` (build the string `data` map). FCM `404 UNREGISTERED` drops the
     activity (the `410` analog); `400`/`401`/`403` do not.
   - SSE `token`/`push-result` events gain `platform`.
6. **`DispatcherConsole.tsx`** (modified): an `[ iOS | Android ]` platform toggle at the top;
   the compose-then-send steps are unchanged and post with the selected platform. The status
   card shows whichever platform's token is live.

## Data payload (sender → service)

```
data = {
  activityId, orderId, status,
  progress,          // "0.7"  (service: toDouble)
  etaEpochMillis,    // "1752..." (service: toLong)
  stopsRemaining,    // "2"   (service: toInt)
  courierName,
  riderReassigned,   // "true"/"false" (service: toBoolean)
  event              // "update" | "end"
}
```
Unlike the iOS content-state (decoded by the widget's Codable), we parse this ourselves — so
there's no silent-shape-drop, but string→typed parsing must be defensive (bad value → skip/log,
never crash the service).

## Error handling

| Failure | Surface |
|---|---|
| `google-services.json` or service-account missing | dispatch server refuses to start (Android path), pointed message |
| FCM `404 UNREGISTERED` | drop token from registry + broadcast (activity-gone analog) |
| FCM `401/403` | service-account/auth error — surfaced verbatim, token NOT dropped |
| FCM `400 INVALID_ARGUMENT` | payload/project mismatch — surfaced verbatim |
| Malformed `data` value in the service | log + skip that field or abort that post; never crash |
| App force-killed / Doze | data message may not arrive — documented reliability gap, not a code bug |
| No `adb` device for token intake | server still starts; Android tokens won't auto-register |

## Testing

- **Unit (`node --test`, no network):** `fcm.mjs` `mintAccessToken` JWT assembly — assert the
  JWT header (`{alg:'RS256', typ:'JWT'}`), claims (`iss`, `scope`, `aud`, `exp`), signed with a
  throwaway RSA key; assert the RS256 signature verifies against the public key.
- **Opt-in integration (`FCM_INTEGRATION=1`, network + real service account):** send to a
  syntactically valid but fake token → expect `404 UNREGISTERED`. Proves the service-account
  auth + OAuth exchange + project id are all correct without a device (the APNs
  `400 BadDeviceToken` analog).
- **Manual (emulator, `google_apis` API 36):** start a delivery, background the app (home;
  not force-kill), push a step from the console → the shade notification + `ProgressStyle` bar
  update. Confirm `onMessageReceived` ran via logcat.
- **Optional hero (Samsung RTL, One UI 8.5):** push + promoted surfaces (status-bar chip,
  top-of-shade) — A5 already established promotion is granted there.

## Out of scope

Multi-device Android registry; a generalized notification framework; iOS changes; guaranteed
delivery under Doze/force-kill (platform limitation). The article documents the gap rather
than engineering around it.

## Article beats unlocked

The iOS/Android push asymmetry (system-updates-widget vs. wakes-your-code); the
data-vs-notification-message trap; FCM HTTP v1 OAuth vs APNs `.p8` JWT; and the honest
delivery-reliability gap between a system-owned Live Activity and a self-re-posted
notification.
