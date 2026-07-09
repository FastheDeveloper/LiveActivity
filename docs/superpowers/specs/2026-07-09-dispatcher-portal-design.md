# DropTrack dispatcher portal — design

**Date:** 2026-07-09
**Status:** approved, not yet implemented
**Context:** TSK-3 proved APNs can drive a Live Activity on a real iPhone with the app
force-quit. Driving it currently means copying a 160-character hex token out of a terminal
and running a CLI. This replaces that with a browser console.

## Goal

An Expo **web** dispatcher console that pushes Live Activity updates to a physical iPhone,
so a delivery can be driven from a browser while the phone sits on the desk with the app
closed. Primary users: the author, driving TSK-4 (Dynamic Island screenshots) and TSK-5
(Android FCM).

This is **test tooling, not article evidence.** It should not grow into the article's
critical path.

## Hard constraints

1. **The browser cannot talk to APNs.** APNs is HTTP/2-only, exposes no CORS headers, and
   requires requests signed with an ES256 key. A local Node process must do the signing.
2. **The `.p8` private key must never reach the browser.** It is read from `APNS_KEY_PATH`
   inside the server process and is not exposed by any route.
3. **The phone is wired-only.** It cannot reach a server on the Mac, so the device cannot
   POST its own token. The token must be scraped from the device console.
4. The server binds `127.0.0.1` only.

## Architecture

```
iPhone ──NSLog──> devicectl --console ──scrape──> dispatch-server (127.0.0.1:8787)
                                                    │  registry: activityId → token
browser (expo web) <──SSE /events──────────────────┘
       └──POST /push──> dispatch-server ──ES256 JWT + HTTP/2──> APNs ──> widget
```

## Components

### 1. `scripts/apns.mjs` — signing + transport core (new)

Extracted from the existing `scripts/push-update.mjs`. No behaviour change; `push-update.mjs`
becomes a thin CLI over it so the CLI path verified in TSK-3 keeps working.

Exports:

- `mintJWT({ keyPath, keyId, teamId })` → `string`
  ES256 JWT. Signature **must** use `dsaEncoding: 'ieee-p1363'`; Node's default DER encoding
  produces a token APNs silently refuses to authenticate.
- `pushLiveActivity({ token, contentState, event, host, bundleId })` → `Promise<{ status, reason }>`
  `apns-topic: <bundleId>.push-type.liveactivity`, `apns-push-type: liveactivity`,
  `apns-priority: 10`. Sets `aps.timestamp` (APNs discards a push whose timestamp is older
  than the last one applied). `event` is `'update' | 'end'`.
- `toAppleEpochSeconds(date)` → `number`
  Swift `Date` decodes as seconds since 2001-01-01, not the Unix epoch
  (`APPLE_EPOCH_OFFSET = 978_307_200`).

`reason` is APNs' JSON `reason` field when present (`BadDeviceToken`, `Unregistered`, …),
otherwise `null`.

### 2. `scripts/dispatch-server.mjs` — signing server (new, zero dependencies)

Node core only: `node:http`, `node:child_process`, plus `apns.mjs`.

**Startup.** Refuses to start with a pointed error if the `.p8` at `APNS_KEY_PATH` is
missing or unreadable — failing at boot rather than at first push. Reads the target device
from `DEVICE_ID` (the `devicectl` identifier, e.g. `D65F7DA3-…`); if unset, it resolves the
single connected iPhone via `devicectl list devices --json-output` and errors if there is
not exactly one. Then spawns:

```
xcrun devicectl device process launch --console --terminate-existing \
  --device $DEVICE_ID <bundleId>
```

Note this **terminates and cold-starts the app**. Running activities survive that (they are
system-owned), and the app re-attaches to them on launch via `getRunningActivities()` — but
a cold start means the token is only re-broadcast if `pushTokenUpdates` re-yields it, which
it does on re-subscribe. The server logs the relaunch plainly so it is never a surprise.

and tails its stdout for `[DropTrack] push token for <activityId>: <hex>`, maintaining a
`Map<activityId, { token, seenAt }>`. Re-emits on token rotation (the same activity id with
a new hex string overwrites and re-broadcasts).

**Routes.**

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/events` | SSE. On connect, replays the current registry as `token` events. Then streams `token` and `push-result` events as they occur. |
| `POST` | `/push` | Body `{ activityId, state, event }`. Signs and sends; broadcasts a `push-result` event; responds `{ status, reason }`. |
| `OPTIONS` | `*` | CORS preflight, `Access-Control-Allow-Origin: http://localhost:8081`. |

`POST /push` resolves `activityId` → token via the registry. A request naming an unknown
activity gets `404` without touching APNs.

**Registry hygiene.** A `410` (`Unregistered`) response removes the activity from the
registry and broadcasts its removal — the activity is genuinely gone. A `400
BadDeviceToken` does **not** remove it; that indicates a sandbox/production host mismatch,
which is a configuration error, not a dead activity.

### 3. `delivery.ts` — shared delivery script (extracted from `App.tsx`)

Moves `STEPS`, `DELIVERED`, `RIDERS`, the `Rider` type, and `toDeliveryState()` out of
`App.tsx` into a module imported by **both** consoles. This shared script is the reason the
console is an Expo web app rather than a static HTML page: one delivery script and one
`DeliveryState` type drive both a native widget and a browser UI.

`App.tsx` keeps its behaviour; it imports what it used to define.

### 4. `DispatcherConsole.tsx` + `Platform.OS === 'web'` branch in `App.tsx`

Rendered only on web. The native path is untouched.

- **Token pill** — `waiting for phone…` until the first SSE `token` event, then
  `<activityId short> · <token first 8>…`.
- **Step list** — the seven `STEPS`, clickable; each sends `event: 'update'`.
- **Courier picker** — the three `RIDERS`.
- **Reassign toggle** — sets `riderReassigned` on the next push.
- **Deliver button** — sends `DELIVERED` with `event: 'end'`.
- **Response log** — newest first: `200`, or `400 BadDeviceToken` etc., colour-coded.

Adds three dependencies: `react-dom`, `react-native-web`, `@expo/metro-runtime`
(via `npx expo install`).

## Error handling

| Failure | Surface |
|---------|---------|
| Dispatch server not running | EventSource `onerror` → "dispatch server offline" banner; UI controls disabled |
| `.p8` missing/unreadable | Server exits at boot with the path it tried |
| No device attached / `devicectl` exits | Server logs it; UI shows "no device console — token intake stopped" |
| APNs `410 Unregistered` | Activity dropped from registry, stepper greys out |
| APNs `400 BadDeviceToken` | Reason string shown verbatim (usually sandbox/prod host mismatch) |
| Push to unknown `activityId` | `404`, no APNs call |

**A `200` from APNs means Apple accepted the bytes, nothing more.** A `content-state` that
fails to decode into the widget's `ContentState` is dropped silently by iOS. The response log
must not imply the widget re-rendered.

## Testing

- **Unit (`node --test`, no network):** `mintJWT` with a throwaway EC key — assert the header
  decodes to `{alg:'ES256', kid}`, the claims to `{iss, iat}`, and that the signature is
  **exactly 64 bytes**. That length assertion pins the DER-vs-P1363 bug.
- **Unit:** `toAppleEpochSeconds` round-trips a known date.
- **Integration (opt-in via env, needs network + real key):** push a syntactically valid but
  fake device token to the sandbox; assert `400 BadDeviceToken`. This proves the key, key id,
  team id and JWT encoding are all correct without a device — the diagnostic that made TSK-3
  tractable.
- **Manual:** start an activity on the phone, click step 4 in the browser, confirm the
  lock-screen card changed. Nothing else proves the widget rendered.

## Out of scope

Multi-device / multi-activity registry, raw JSON payload editor, authentication, persistence
across restarts, Android + FCM. TSK-5 may widen the registry; it should not be built for
speculatively now.

## Security notes

- Server binds `127.0.0.1` only; never `0.0.0.0`.
- `.p8` path comes from `APNS_KEY_PATH` (default `~/Downloads/AuthKey_XLZP8ZR76B.p8`).
  `*.p8` is already gitignored; the key is never copied into the repo.
- CORS is restricted to the Expo web origin. No route returns key material.
- The full push token *is* returned to the browser — it is a per-activity capability, local
  to this machine, and needed for copy-paste into the CLI.
