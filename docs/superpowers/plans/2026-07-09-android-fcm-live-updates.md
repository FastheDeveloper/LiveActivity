# Android FCM Push-Driven Live Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A data-only FCM push, sent from the extended dispatcher portal, updates the DropTrack Android Live Update notification while the app is backgrounded — the Android counterpart to the iOS APNs work (TSK-3).

**Architecture:** A `FirebaseMessagingService` in the Kotlin module receives a high-priority data message and rebuilds/re-posts the `NotificationCompat` Live Update via a shared `DeliveryNotifier` (extracted from the module's current `postDelivery`, so both the JS path and the push path produce an identical notification). A zero-dependency `scripts/fcm.mjs` (FCM HTTP v1, OAuth2 via a service account) sends the message; the dispatch server gains an Android path and an `adb logcat` token scrape, and the web console gets an iOS/Android toggle.

**Tech Stack:** Kotlin + `firebase-messaging` (Firebase BoM), `androidx.core` 1.17 (existing), a local Expo config plugin for `google-services`, Node core (`node:crypto`, global `fetch`, `node:test`) for the sender, React Native Web for the console.

---

## File Structure

**Native — `modules/droptrack-live/android/src/main/`:**
- Create `java/expo/modules/droptracklive/DeliveryNotifier.kt` — the notification builder, extracted from the module's private `postDelivery`. Plain-typed params, callable from any entry point.
- Modify `java/expo/modules/droptracklive/DroptrackLiveModule.kt` — delegate to `DeliveryNotifier`; add `getFcmToken()` + `onFcmTokenReceived` event.
- Create `java/expo/modules/droptracklive/DroptrackFcmService.kt` — `onMessageReceived` → `DeliveryNotifier`; `onNewToken` logs for the scrape.
- Modify `AndroidManifest.xml` — register the service.

**Native gradle:**
- Modify `modules/droptrack-live/android/build.gradle` — add `firebase-messaging` via the Firebase BoM.

**Config plugin (app-level):**
- Create `plugins/withAndroidFcm.js` — places `google-services.json`, adds the `google-services` gradle classpath + apply.
- Modify `app.json` — reference the plugin.
- Modify `.gitignore` — ignore `google-services.json` + service-account keys.

**Sender / control plane:**
- Create `scripts/fcm.mjs` — FCM HTTP v1 client.
- Create `scripts/fcm.test.mjs` — unit + opt-in integration tests.
- Modify `scripts/dispatch-server.mjs` — platform-aware registry + `/push` routing + `adb logcat` scrape.
- Modify `src/dispatchClient.ts` — carry `platform`.
- Modify `DispatcherConsole.tsx` — iOS/Android toggle.

**User-provided (gitignored):** `google-services.json` (repo root), a service-account JSON.

---

## Task 1: Firebase project + credentials (manual, user) + gitignore

**Files:**
- Modify: `.gitignore`
- User provides (gitignored): `google-services.json`, `<service-account>.json`

- [ ] **Step 1: Create the Firebase project (user, in the browser)**

1. https://console.firebase.google.com → Add project (e.g. "DropTrack").
2. Add an **Android** app: package name `com.fasarticle.droptrack`. Download **`google-services.json`** and place it at the repo root: `/Users/fas/2025.nosync/LiveActivity/google-services.json`.
3. Project settings → **Service accounts** → **Generate new private key** → save the JSON to the repo root as `fcm-service-account.json`.

- [ ] **Step 2: Gitignore both credential files**

Append to `.gitignore`:

```
# Firebase / FCM credentials (never commit)
google-services.json
fcm-service-account.json
*service-account*.json
```

- [ ] **Step 3: Verify they exist and are ignored**

Run:
```
ls google-services.json fcm-service-account.json && git check-ignore google-services.json fcm-service-account.json
```
Expected: both files listed by `ls`, and both echoed by `git check-ignore` (proving they're ignored).

- [ ] **Step 4: Commit the gitignore change**

```bash
git add .gitignore
git commit -m "chore: gitignore Firebase/FCM credential files"
```

---

## Task 2: `scripts/fcm.mjs` — FCM HTTP v1 client (TDD)

**Files:**
- Create: `scripts/fcm.mjs`
- Test: `scripts/fcm.test.mjs`

FCM v1 is plain HTTPS/1.1 (unlike APNs' HTTP/2), so Node's global `fetch` works. Auth is a
service-account RS256 JWT exchanged for an OAuth access token.

- [ ] **Step 1: Write the failing unit test**

Create `scripts/fcm.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { buildAuthJWT } from './fcm.mjs';

// A throwaway RSA key standing in for the service-account private key.
function fakeServiceAccount() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pk = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    sa: {
      client_email: 'sa@droptrack.iam.gserviceaccount.com',
      private_key: pk,
      token_uri: 'https://oauth2.googleapis.com/token',
      project_id: 'droptrack-test',
    },
    publicKey,
  };
}

const b64urlToJSON = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('buildAuthJWT makes a valid RS256 service-account JWT', () => {
  const { sa, publicKey } = fakeServiceAccount();
  const jwt = buildAuthJWT(sa);
  const [header, claims, sig] = jwt.split('.');

  assert.deepEqual(b64urlToJSON(header), { alg: 'RS256', typ: 'JWT' });
  const c = b64urlToJSON(claims);
  assert.equal(c.iss, 'sa@droptrack.iam.gserviceaccount.com');
  assert.equal(c.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(c.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(typeof c.iat, 'number');
  assert.equal(c.exp, c.iat + 3600);

  // The signature must actually verify against the public key (RS256 over
  // header.claims). This is the real correctness check.
  const v = createVerify('RSA-SHA256');
  v.update(`${header}.${claims}`);
  v.end();
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')), 'signature verifies');
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test scripts/fcm.test.mjs`
Expected: FAIL — cannot find `./fcm.mjs`.

- [ ] **Step 3: Write `scripts/fcm.mjs`**

```js
// FCM HTTP v1 client for Android Live Update pushes. Zero dependencies
// (node:crypto + global fetch). The Android counterpart to apns.mjs.
//
// Auth: a service-account RS256 JWT, exchanged for a short-lived OAuth access
// token, used as a bearer against the v1 send endpoint. Unlike APNs (HTTP/2 +
// .p8 ES256), FCM v1 is plain HTTPS + an RS256 service-account key.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export const config = {
  serviceAccountPath: process.env.FCM_SERVICE_ACCOUNT ?? 'fcm-service-account.json',
};

function loadServiceAccount(path = config.serviceAccountPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// RS256 JWT asserting the service account, scoped to FCM send.
export function buildAuthJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(sig)}`;
}

let cachedToken = null; // { token, exp }

// Exchange the JWT for an OAuth access token (cached until ~1 min before expiry).
export async function getAccessToken(sa = loadServiceAccount()) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const jwt = buildAuthJWT(sa);
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  cachedToken = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
  return cachedToken.token;
}

// Send one high-priority, data-only message. Resolves { status, reason }.
// reason is the FCM error `status` (e.g. UNREGISTERED, INVALID_ARGUMENT) or null.
export async function sendDataMessage({ token, data, sa = loadServiceAccount() }) {
  const accessToken = await getAccessToken(sa);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // Data-only (no `notification`) + high priority: routes to
      // onMessageReceived even when backgrounded, and wakes the app promptly.
      body: JSON.stringify({
        message: { token, data, android: { priority: 'high' } },
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  const reason = body?.error?.status ?? null;
  return { status: res.status, reason };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `node --test scripts/fcm.test.mjs`
Expected: PASS (1 test) — the RS256 signature verifies.

- [ ] **Step 5: Commit**

```bash
git add scripts/fcm.mjs scripts/fcm.test.mjs
git commit -m "feat: zero-dep FCM HTTP v1 client with service-account JWT test"
```

---

## Task 3: Opt-in FCM auth probe (integration test)

**Files:**
- Modify: `scripts/fcm.test.mjs`

- [ ] **Step 1: Append the integration test**

```js
// Opt-in: needs network + the real service account. Run with FCM_INTEGRATION=1.
// Proves the service account + OAuth exchange + project id are correct WITHOUT a
// device: a syntactically valid but fake registration token must come back
// 404 UNREGISTERED (the APNs 400 BadDeviceToken analog).
test('FCM rejects a fake token with UNREGISTERED (auth is correct)', { skip: process.env.FCM_INTEGRATION !== '1' }, async () => {
  const { sendDataMessage } = await import('./fcm.mjs');
  const fakeToken = 'fake-token-' + 'a'.repeat(120);
  const { status, reason } = await sendDataMessage({
    token: fakeToken,
    data: { status: 'test', progress: '0', event: 'update' },
  });
  // 404 UNREGISTERED = auth OK, token unknown. 401/403 would mean bad credentials.
  assert.equal(status, 404);
  assert.equal(reason, 'UNREGISTERED');
});
```

- [ ] **Step 2: Run default suite (integration skipped)**

Run: `node --test scripts/fcm.test.mjs`
Expected: 1 pass, 1 skipped.

- [ ] **Step 3: Run the integration probe against the real service account**

Run: `FCM_INTEGRATION=1 node --test scripts/fcm.test.mjs`
Expected: 2 pass. (Requires `fcm-service-account.json` + network.) If it fails with `401/403`, the service account is wrong — stop and fix. If `INVALID_ARGUMENT`, the project id/token format is off.

- [ ] **Step 4: Commit**

```bash
git add scripts/fcm.test.mjs
git commit -m "test: opt-in FCM auth probe (fake token -> UNREGISTERED)"
```

---

## Task 4: Extract `DeliveryNotifier.kt` (shared notification builder)

**Files:**
- Create: `modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DeliveryNotifier.kt`
- Modify: `modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackLiveModule.kt`

The current `postDelivery`/`ensureChannel`/`courierLine`/`stopsLabel`/`notificationIdFor` and
the constants live inside the module and take Expo `Record`s. Move the notification-building
into a plain object so the FCM service (a separate entry point) can build the identical
notification.

- [ ] **Step 1: Create `DeliveryNotifier.kt`**

```kotlin
package expo.modules.droptracklive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.graphics.drawable.IconCompat

// Shared notification builder. Called from BOTH the Expo module (JS-driven,
// local) and DroptrackFcmService (push-driven, from a background process that
// has no access to the module's in-memory state). Everything needed to render
// is passed in — no shared mutable state.
object DeliveryNotifier {
  const val TAG = "DroptrackLive"
  private const val CHANNEL_ID = "droptrack.delivery"
  private const val BRAND_ORANGE = 0xFFFF6B2C.toInt()

  private val mainHandler = Handler(Looper.getMainLooper())

  fun notificationIdFor(activityId: String) = activityId.hashCode()

  fun ensureChannel(ctx: Context) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Delivery updates",
      NotificationManager.IMPORTANCE_HIGH
    ).apply { description = "Live progress of your active deliveries" }
    manager.createNotificationChannel(channel)
  }

  fun post(
    ctx: Context,
    activityId: String,
    orderId: String,
    status: String,
    progress: Double,
    etaEpochMillis: Double,
    stopsRemaining: Int,
    courierName: String,
    riderReassigned: Boolean,
    ongoing: Boolean,
  ) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val progressPercent = (progress.coerceIn(0.0, 1.0) * 100).toInt()

    val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_delivery)
      .setContentTitle(status)                 // promotion REQUIRES a title
      .setContentText(courierLine(courierName, riderReassigned, stopsRemaining))
      .setSubText("Order $orderId")
      .setOngoing(ongoing)                     // promotion REQUIRES ongoing
      .setOnlyAlertOnce(true)
      .setColor(BRAND_ORANGE)
      .setShortCriticalText("$progressPercent%")
      .setRequestPromotedOngoing(ongoing)

    if (etaEpochMillis > System.currentTimeMillis()) {
      builder.setWhen(etaEpochMillis.toLong()).setShowWhen(true)
    }

    if (Build.VERSION.SDK_INT >= 36) {
      val style = NotificationCompat.ProgressStyle()
        .setStyledByProgress(true)
        .setProgress(progressPercent)
        .setProgressTrackerIcon(IconCompat.createWithResource(ctx, R.drawable.ic_delivery))
        .setProgressSegments(
          listOf(NotificationCompat.ProgressStyle.Segment(100).setColor(BRAND_ORANGE))
        )
        .setProgressPoints(
          listOf(NotificationCompat.ProgressStyle.Point(35).setColor(Color.WHITE))
        )
      builder.setStyle(style)
    } else {
      builder.setProgress(100, progressPercent, false)
    }

    val notification = builder.build()
    if (Build.VERSION.SDK_INT >= 36) {
      Log.d(TAG, "hasPromotableCharacteristics=${notification.hasPromotableCharacteristics()}")
    }
    manager.notify(notificationIdFor(activityId), notification)
  }

  fun cancelAfter(ctx: Context, activityId: String, delayMs: Long) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    mainHandler.postDelayed({ manager.cancel(notificationIdFor(activityId)) }, delayMs)
  }

  private fun stopsLabel(stops: Int) = when (stops) {
    0 -> "you're next"
    1 -> "1 stop away"
    else -> "$stops stops away"
  }

  private fun courierLine(courierName: String, riderReassigned: Boolean, stops: Int) =
    if (riderReassigned) "🔄 New rider: $courierName · ${stopsLabel(stops)}"
    else "$courierName · ${stopsLabel(stops)}"
}
```

- [ ] **Step 2: Rewrite `DroptrackLiveModule.kt` to delegate**

Replace the module's private `postDelivery`, `ensureChannel`, `notificationIdFor`,
`stopsLabel`, `courierLine`, and the `TAG`/`CHANNEL_ID`/`BRAND_ORANGE` constants with
delegation. The `AsyncFunction` bodies become:

```kotlin
    AsyncFunction("startDelivery") { info: DeliveryInfoRecord, state: DeliveryStateRecord ->
      val ctx = context ?: throw NoContextException()
      DeliveryNotifier.ensureChannel(ctx)
      val activityId = "delivery-${info.orderId}"
      deliveries[activityId] = info
      postState(ctx, activityId, info, state, ongoing = true)
      return@AsyncFunction activityId
    }

    AsyncFunction("updateDelivery") { activityId: String, state: DeliveryStateRecord ->
      val ctx = context ?: throw NoContextException()
      val info = deliveries[activityId] ?: throw ActivityNotFoundException(activityId)
      postState(ctx, activityId, info, state, ongoing = true)
    }

    AsyncFunction("endDelivery") { activityId: String, state: DeliveryStateRecord, dismissAfterSeconds: Double? ->
      val ctx = context ?: throw NoContextException()
      val info = deliveries.remove(activityId) ?: throw ActivityNotFoundException(activityId)
      postState(ctx, activityId, info, state, ongoing = false)
      if (dismissAfterSeconds != null) {
        DeliveryNotifier.cancelAfter(ctx, activityId, (dismissAfterSeconds * 1000).toLong())
      }
    }
```

Add this private helper (unpacks Records → the shared builder):

```kotlin
  private fun postState(
    ctx: Context,
    activityId: String,
    info: DeliveryInfoRecord,
    state: DeliveryStateRecord,
    ongoing: Boolean,
  ) {
    DeliveryNotifier.post(
      ctx, activityId, info.orderId, state.status, state.progress,
      state.etaEpochMillis, state.stopsRemaining, state.courierName,
      state.riderReassigned, ongoing,
    )
  }
```

Delete the now-unused private members (`postDelivery`, `ensureChannel`, `notificationIdFor`,
`stopsLabel`, `courierLine`, `TAG`, `CHANNEL_ID`, `BRAND_ORANGE`), but KEEP `context`,
`notificationManager` (still used by `areActivitiesEnabled`/`canPostPromotedNotifications`),
`deliveries`, and `mainHandler` removal (the handler moved to `DeliveryNotifier`; delete the
module's `mainHandler`). Leave the `Constants`, `areActivitiesEnabled`,
`canPostPromotedNotifications` blocks unchanged.

- [ ] **Step 3: Build to confirm it compiles + the JS-driven path is unchanged**

Run: `npx expo run:android --device <emulator-or-device>` (emulator booted).
Expected: `BUILD SUCCESSFUL`, app installs. In the dev console, tap Start / Advance → the
notification still posts and updates as before (no behavior change — pure refactor).
(There is no JVM unit-test harness for this Expo module, so the Android build + the existing
manual dev-console flow are the verification.)

- [ ] **Step 4: Commit**

```bash
git add modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DeliveryNotifier.kt \
  modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackLiveModule.kt
git commit -m "refactor: extract DeliveryNotifier so any entry point can post the Live Update"
```

---

## Task 5: FCM dependency, service, token API + manifest

**Files:**
- Modify: `modules/droptrack-live/android/build.gradle`
- Create: `modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackFcmService.kt`
- Modify: `modules/droptrack-live/android/src/main/AndroidManifest.xml`
- Modify: `modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackLiveModule.kt`

- [ ] **Step 1: Add `firebase-messaging` to the module gradle**

In `modules/droptrack-live/android/build.gradle`, extend `dependencies`:

```gradle
dependencies {
  implementation 'androidx.core:core-ktx:1.17.0'
  // FCM: FirebaseMessaging + FirebaseMessagingService for push-driven updates.
  implementation platform('com.google.firebase:firebase-bom:33.7.0')
  implementation 'com.google.firebase:firebase-messaging'
}
```

- [ ] **Step 2: Create `DroptrackFcmService.kt`**

```kotlin
package expo.modules.droptracklive

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// Receives data-only FCM messages and re-posts the Live Update. Runs in the
// app process even when backgrounded — this is the whole point: Android has no
// system-managed remote update, so OUR code renders every push. It has no
// access to the module's in-memory `deliveries` map (that lives in a possibly-
// dead module instance), so every field is read from the message payload.
class DroptrackFcmService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    // The dispatch server scrapes this line from `adb logcat`.
    Log.i(DeliveryNotifier.TAG, "[DropTrack] fcm token: $token")
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val d = message.data
    val activityId = d["activityId"] ?: return
    val event = d["event"] ?: "update"
    ensureAndPost(activityId, d, ongoing = event != "end")
    if (event == "end") {
      DeliveryNotifier.cancelAfter(this, activityId, 30_000L)
    }
  }

  private fun ensureAndPost(activityId: String, d: Map<String, String>, ongoing: Boolean) {
    DeliveryNotifier.ensureChannel(this)
    DeliveryNotifier.post(
      ctx = this,
      activityId = activityId,
      orderId = d["orderId"] ?: "",
      status = d["status"] ?: "",
      progress = d["progress"]?.toDoubleOrNull() ?: 0.0,
      etaEpochMillis = d["etaEpochMillis"]?.toDoubleOrNull() ?: 0.0,
      stopsRemaining = d["stopsRemaining"]?.toIntOrNull() ?: 0,
      courierName = d["courierName"] ?: "",
      riderReassigned = d["riderReassigned"]?.toBoolean() ?: false,
      ongoing = ongoing,
    )
  }
}
```

- [ ] **Step 3: Register the service in the module `AndroidManifest.xml`**

Replace the manifest with (adds an `<application>` wrapping the service; the merger folds it
into the app manifest):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <!-- Runtime permission (API 33+) to post any notification at all -->
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <!-- Install-time permission (API 36+) required for Live Updates promotion -->
  <uses-permission android:name="android.permission.POST_PROMOTED_NOTIFICATIONS" />

  <application>
    <service
      android:name="expo.modules.droptracklive.DroptrackFcmService"
      android:exported="false">
      <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
      </intent-filter>
    </service>
  </application>
</manifest>
```

- [ ] **Step 4: Add `getFcmToken()` + `onFcmTokenReceived` to the module**

In `DroptrackLiveModule.kt`, add these imports:

```kotlin
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
```

Inside `ModuleDefinition {}`, add the event declaration near `Name("DroptrackLive")`:

```kotlin
    Events("onFcmTokenReceived")
```

And add this function (also logs the token so the `adb logcat` scrape sees it on Start, even
without a rotation):

```kotlin
    AsyncFunction("getFcmToken") { promise: Promise ->
      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token ->
          android.util.Log.i(DeliveryNotifier.TAG, "[DropTrack] fcm token: $token")
          sendEvent("onFcmTokenReceived", mapOf("token" to token))
          promise.resolve(token)
        }
        .addOnFailureListener { e -> promise.reject("E_FCM_TOKEN", e.message ?: "token fetch failed", e) }
    }
```

- [ ] **Step 5: Build + verify the token logs and the service registers**

Precondition: Task 6 (config plugin + `google-services.json`) is required for Firebase to
initialize. **If Task 6 is not yet done, do it before this build** (the two are
interdependent; build once both are in place). After building:

Run: `npx expo run:android --device <emulator>` then, from the app, trigger `getFcmToken()`
(add a temporary call or use the existing dev console once Task 8 wires it — for now, a
`__DEV__` `useEffect(() => { DroptrackLive.getFcmToken?.().then(console.log) }, [])` in
App.tsx is acceptable, reverted after).
Verify: `adb logcat -s DroptrackLive:I | grep "fcm token"` prints `[DropTrack] fcm token: <token>`.

- [ ] **Step 6: Commit**

```bash
git add modules/droptrack-live/android/build.gradle \
  modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackFcmService.kt \
  modules/droptrack-live/android/src/main/AndroidManifest.xml \
  modules/droptrack-live/android/src/main/java/expo/modules/droptracklive/DroptrackLiveModule.kt
git commit -m "feat: FCM messaging service + getFcmToken/onFcmTokenReceived"
```

---

## Task 6: `plugins/withAndroidFcm.js` config plugin + app.json

**Files:**
- Create: `plugins/withAndroidFcm.js`
- Modify: `app.json`

Because `android/` is generated by prebuild (CNG), the Firebase gradle wiring and
`google-services.json` placement must be applied by a config plugin on every prebuild.

- [ ] **Step 1: Create `plugins/withAndroidFcm.js`**

```js
const { withProjectBuildGradle, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICES_VERSION = '4.4.2';

// 1. Add the google-services classpath to the project build.gradle.
function withGoogleServicesClasspath(config) {
  return withProjectBuildGradle(config, (cfg) => {
    const line = `classpath('com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}')`;
    if (!cfg.modResults.contents.includes(line)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        (m) => `${m}\n        ${line}`
      );
    }
    return cfg;
  });
}

// 2. Apply the google-services plugin in the app build.gradle.
function withApplyGoogleServices(config) {
  return withAppBuildGradle(config, (cfg) => {
    const line = "apply plugin: 'com.google.gms.google-services'";
    if (!cfg.modResults.contents.includes(line)) {
      cfg.modResults.contents += `\n${line}\n`;
    }
    return cfg;
  });
}

// 3. Copy google-services.json (repo root) into android/app/ during prebuild.
function withGoogleServicesJson(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'google-services.json');
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'google-services.json');
      if (!fs.existsSync(src)) {
        throw new Error('[withAndroidFcm] google-services.json not found at project root');
      }
      fs.copyFileSync(src, dest);
      return cfg;
    },
  ]);
}

module.exports = (config) =>
  withGoogleServicesJson(withApplyGoogleServices(withGoogleServicesClasspath(config)));
```

- [ ] **Step 2: Reference the plugin in `app.json`**

Add `"./plugins/withAndroidFcm"` to `expo.plugins` (alongside the `@bacons/apple-targets`
entry):

```json
"plugins": [
  ["@bacons/apple-targets", { "appleTeamId": "V993Z3KD7P" }],
  "./plugins/withAndroidFcm"
]
```

- [ ] **Step 3: Prebuild to verify the plugin applies cleanly**

Run: `npx expo prebuild -p android --clean`
Expected: no errors; then verify:
```
grep -R "com.google.gms.google-services" android/app/build.gradle
grep -R "com.google.gms:google-services" android/build.gradle
ls android/app/google-services.json
```
All three succeed. (If `google-services.json` is missing at the root, the plugin throws the
pointed error from Step 1 — that's the intended fail-fast.)

- [ ] **Step 4: Commit**

```bash
git add plugins/withAndroidFcm.js app.json
git commit -m "feat: config plugin wiring google-services for FCM through CNG"
```

---

## Task 7: Dispatch server — Android path + `adb logcat` token scrape

**Files:**
- Modify: `scripts/dispatch-server.mjs`

The server currently registers iOS tokens (via `devicectl --console`) and pushes via
`apns.mjs`. Add: an `adb logcat` scraper for the FCM token, a `platform` on registry entries
and `/push`, and routing to `fcm.mjs`.

- [ ] **Step 1: Import the FCM client + track platform**

At the top of `scripts/dispatch-server.mjs`, add:

```js
import { sendDataMessage } from './fcm.mjs';
```

Change registry entries to store platform. Where the registry is written (`registerToken`),
add a platform argument:

```js
// activityId -> { token, platform, seenAt }
export function registerToken(activityId, token, platform) {
  const existing = registry.get(activityId);
  if (existing && existing.token === token) return;
  registry.set(activityId, { token, platform, seenAt: Date.now() });
  broadcast('token', { activityId, token, platform });
  console.log(`[dispatch] ${platform} token registered for ${activityId}: ${token.slice(0, 8)}…`);
}
```

Update the SSE replay-on-connect and the iOS `devicectl` scraper's `registerToken` call to
pass `'ios'`. (The iOS scraper's regex match calls `registerToken(m[1], m[2], 'ios')`.)

- [ ] **Step 2: Add the `adb logcat` FCM token scraper**

Add near `startConsoleScraper` (mirrors it for Android):

```js
// Scrape the FCM registration token from `adb logcat`. The app logs
// `[DropTrack] fcm token: <token>` (module getFcmToken + service onNewToken).
function startLogcatScraper() {
  console.log('[dispatch] attaching adb logcat for FCM tokens (Android)');
  // -s filters to our tag at Info; the app logs under "DroptrackLive".
  const child = spawn('adb', ['logcat', '-s', 'DroptrackLive:I']);
  const re = /\[DropTrack\] fcm token: ([A-Za-z0-9:_\-]+)/;
  let buf = '';
  const feed = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = buf.slice(0, i).match(re);
      if (m) registerToken(`android-${m[1].slice(0, 8)}`, m[1], 'android');
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => console.error(`[dispatch] adb logcat exited (code ${code})`));
  return child;
}
```

Note: the FCM token has no per-activity id like APNs; the Android "activityId" in the registry
is a synthetic `android-<prefix>` key. The web console targets it via the platform toggle
(Task 8), and the push `data.activityId` uses the real delivery id
(`delivery-<orderId>`) — see Step 3.

- [ ] **Step 3: Route `/push` by platform**

The existing handler already destructures `const { activityId, state, event } = payload;` and
resolves `entry` from the registry (keep those lines and the `parseJson`/404-unknown-activity
guards). Add `platform` to the destructure and replace the single `pushLiveActivity` call with
this branch:

```js
    // existing line, extended: const { activityId, state, event } = payload;
    const platform = payload.platform ?? entry.platform ?? 'ios';
    let result;
    if (platform === 'android') {
      // FCM data values must be strings. activityId in the payload is the
      // delivery id the service will re-post under.
      const data = {
        activityId: `delivery-${state.orderId ?? 'DT-4521'}`,
        orderId: String(state.orderId ?? 'DT-4521'),
        status: String(state.status),
        progress: String(state.progress),
        etaEpochMillis: String(state.etaEpochMillis),
        stopsRemaining: String(state.stopsRemaining),
        courierName: String(state.courierName),
        riderReassigned: String(!!state.riderReassigned),
        event: event ?? 'update',
      };
      result = await sendDataMessage({ token: entry.token, data });
      if (result.status === 404) dropActivity(activityId); // UNREGISTERED
    } else {
      result = await pushLiveActivity({ token: entry.token, contentState: toContentState(state), event });
      if (result.status === 410) dropActivity(activityId);
    }
    broadcast('push-result', { activityId, platform, ...result, at: Date.now() });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
```

- [ ] **Step 4: Start the logcat scraper on boot**

In the `server.listen` callback, after the iOS `startConsoleScraper()` try/catch, add an
Android one, gated so it only runs when an `adb` device is attached:

```js
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
    if (out.split('\n').some((l) => /\tdevice$/.test(l))) startLogcatScraper();
    else console.log('[dispatch] no adb device — Android FCM token intake skipped');
  } catch {
    console.log('[dispatch] adb not found — Android FCM token intake skipped');
  }
```

Note: `s.orderId` must reach the server. The delivery script's `toDeliveryState` does not
include `orderId`; the web console (Task 8) adds `orderId: ORDER.orderId` to the pushed state
for the Android path.

- [ ] **Step 5: Verify with the debug route (no device needed)**

Run: `DISPATCH_ALLOW_DEBUG=1 node scripts/dispatch-server.mjs`
Inject an Android token and push (server has the fake token; FCM will 404 on the fake token,
which is the expected "auth OK" signal — requires `fcm-service-account.json`):
```
curl -s -X POST http://127.0.0.1:8787/debug/token -d '{"activityId":"android-test","token":"fake-token-aaaa","platform":"android"}'
curl -s -X POST http://127.0.0.1:8787/push -H 'Content-Type: application/json' -d '{"activityId":"android-test","platform":"android","event":"update","state":{"orderId":"DT-4521","status":"On the way","progress":0.5,"etaEpochMillis":0,"stopsRemaining":2,"courierName":"Ade","riderReassigned":false}}'
```
(Extend `/debug/token` to accept + pass `platform`.) Expected: the push returns
`{"status":404,"reason":"UNREGISTERED"}` — proving the Android routing + `fcm.mjs` wiring work
end to end without a device. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add scripts/dispatch-server.mjs
git commit -m "feat: dispatch server Android FCM path + adb logcat token scrape"
```

---

## Task 8: Web console — iOS/Android toggle

**Files:**
- Modify: `src/dispatchClient.ts`
- Modify: `DispatcherConsole.tsx`

- [ ] **Step 1: Carry `platform` through the client**

In `src/dispatchClient.ts`, update `PushResult` and `sendPush`:

```ts
export type PushResult = { activityId: string; platform: 'ios' | 'android'; status: number; reason: string | null; at: number };

export async function sendPush(
  activityId: string,
  state: DeliveryState & { orderId?: string },
  event: 'update' | 'end',
  platform: 'ios' | 'android'
): Promise<{ status: number; reason: string | null }> {
  const res = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId, state, event, platform }),
  });
  return res.json();
}
```

Also thread `platform` into `onToken` so the console can show the active platform's token:

```ts
  onToken: (activityId: string, token: string, platform: 'ios' | 'android') => void;
```
and in the `token` listener: `handlers.onToken(activityId, token, JSON.parse(...).platform)`.

- [ ] **Step 2: Add the toggle + platform-aware send in `DispatcherConsole.tsx`**

Add state and a toggle row at the top of the render (below the title):

```tsx
  const [platform, setPlatform] = useState<'ios' | 'android'>('ios');
```

```tsx
      <View style={styles.card}>
        <Text style={styles.heading}>Platform</Text>
        <View style={styles.riders}>
          {(['ios', 'android'] as const).map((p) => (
            <Pressable key={p} onPress={() => setPlatform(p)}
              style={[styles.chip, platform === p && styles.chipActive]}>
              <Text style={[styles.chipText, platform === p && styles.chipTextActive]}>
                {p === 'ios' ? 'iOS' : 'Android'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
```

Update the `onToken` handler to only adopt tokens for the selected platform, and the `send`
to pass `platform` + `orderId` (import `ORDER` from `./delivery`):

```tsx
import { STEPS, DELIVERED, RIDERS, ORDER, toDeliveryState, type Rider } from './delivery';
```

```tsx
      onToken: (id, tok, tokPlatform) => {
        if (tokPlatform !== platform) return;
        setActivityId(id);
        setToken(tok);
      },
```

```tsx
    await sendPush(
      activityId,
      { ...toDeliveryState(selectedStep, rider), orderId: ORDER.orderId },
      isEnd ? 'end' : 'update',
      platform
    );
```

Because `onToken` now depends on `platform`, move the `connectDispatch` effect's dependency:
change `useEffect(() => {...}, [])` to re-subscribe when platform changes, or read platform via
a ref. Use a ref to avoid reconnecting the SSE:

```tsx
  const platformRef = useRef(platform);
  platformRef.current = platform;
```
and in `onToken` compare against `platformRef.current`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dispatchClient.ts DispatcherConsole.tsx
git commit -m "feat: iOS/Android platform toggle in the dispatcher console"
```

---

## Task 9: End-to-end on the emulator + docs

**Files:** none (verification) + DEVLOG/GOTCHAS

- [ ] **Step 1: Boot the google_apis API 36 emulator + install**

Run: `emulator -avd <api36-google-apis-avd>` (has Google Play Services for FCM), then
`npx expo run:android`. Grant the notification permission when prompted.

- [ ] **Step 2: Start dispatch + register the Android token**

Run: `npm run dispatch` (with the emulator running; the `adb logcat` scraper attaches). In the
app, tap **Start** (or trigger `getFcmToken`). The server logs
`[dispatch] android token registered …`.

- [ ] **Step 3: Push while backgrounded**

Press Home on the emulator (background the app — do NOT force-kill). In the web console, select
**Android**, stage **"2 stops away"**, press **Send notification**. Expected: `200` in the
responses log, and the shade notification updates to "2 stops away" with the ProgressStyle bar
advanced. Confirm `onMessageReceived` ran: `adb logcat -s DroptrackLive:D | grep hasPromotable`.

- [ ] **Step 4: Failure-mode check**

End the activity (send "Delivered"), then push a step → FCM path still returns 200 (FCM
accepts; the service re-posts an ended notification) OR observe the reliability note if the app
was force-killed (message may not arrive — expected, documented).

- [ ] **Step 5: Document**

Append a DEVLOG entry (the iOS/Android asymmetry, data-vs-notification message, FCM v1 OAuth vs
APNs .p8, the Doze/force-kill reliability gap) and add any new GOTCHAS surfaced. Note the
Samsung RTL promoted-surface verification as optional follow-up.

```bash
git add DEVLOG.md GOTCHAS.md
git commit -m "docs: TSK-5 Android FCM devlog + gotchas"
```

---

## Notes for the implementer

- **Tasks 5 and 6 are interdependent** (Firebase won't initialize without the config plugin +
  `google-services.json`, and the service won't compile-link without `firebase-messaging`).
  Implement both, then do the first Android build.
- **Data messages, not notification messages.** Never add a `notification` block to the FCM
  payload — it would be handled by the system tray when backgrounded and never reach
  `onMessageReceived`.
- **FCM data is `map<string,string>`.** The sender stringifies; the service parses defensively
  (`toDoubleOrNull` etc.) and never crashes on a bad value.
- **The service can't see the module's `deliveries` map** — it's a background entry point.
  Every field comes from the payload. That asymmetry is the point of the task.
- **Reliability gap is expected, not a bug:** data messages can be dropped under Doze or after
  a force-kill. Test with the app backgrounded (Home), not swiped-away. Document, don't fix.
- **A `200`/accepted from FCM ≠ rendered.** Confirm on the device shade, like the iOS side.
