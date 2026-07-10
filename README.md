# DropTrack — React Native Live Activities (iOS) + Live Updates (Android)

A mock delivery tracker that demonstrates one cross-platform TypeScript API driving two very
different native implementations:

- **iOS Live Activity** (ActivityKit + WidgetKit) — a lock-screen card and Dynamic Island with a
  segmented progress bar, driven from React Native and updatable remotely over APNs.
- **Android Live Update** (`Notification.ProgressStyle`, Android 16 / API 36) — the same delivery
  flow as a promoted ongoing notification with a status-bar chip, updatable remotely over FCM.

A single `DeliveryState` object flows through a SwiftUI widget, an Android promoted notification,
and an Expo-web dispatcher console. The APNs and FCM push clients are written from scratch with no
push libraries (Node built-ins only). See [`GOTCHAS.md`](./GOTCHAS.md) for the full list of traps
and fixes hit while building it.

## Repository layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `delivery.ts` | The React Native app and the shared step model |
| `modules/droptrack-live/` | The custom Expo module: the TypeScript API plus the iOS (Swift) and Android (Kotlin) native code |
| `targets/widgets/` | The iOS widget extension (SwiftUI `ActivityConfiguration`) |
| `plugins/withAndroidFcm.js` | Config plugin that wires `google-services` through prebuild |
| `DispatcherConsole.tsx`, `src/dispatchClient.ts` | The Expo-web console for composing and firing pushes |
| `scripts/` | The from-scratch APNs and FCM clients, plus the local signing/dispatch server |

## Prerequisites

- **macOS** with **Xcode 26+**. For the Dynamic Island, an **iOS 18+ simulator** or an **iPhone 14
  Pro or newer** on iOS 16.2+.
- **Android SDK** with the **API 36** platform and an **API 36 `google_apis` emulator** (Live
  Updates need Android 16, and FCM needs Google Play services).
- **Node 20+** and **JDK 17**.
- A **paid Apple Developer account** only for the APNs push phase. Local updates work without one.

## Getting started

```bash
npm install
npx expo prebuild          # generates ios/ and android/ (this project uses CNG)
npx expo run:ios           # or: npx expo run:android
```

Once the app is running, drive the delivery forward with the in-app buttons. Everything except the
remote-push phases works with no extra configuration.

## Remote push (optional)

Remote updates are what make the card change while the app is force-quit. Each platform needs its
own credentials, and **none of them are committed** — you supply your own.

### iOS (APNs)

1. Create an **APNs Auth Key** (`.p8`) in your Apple Developer account and note its Key ID and your
   Team ID.
2. Add the `aps-environment` entitlement (already declared in `app.json`) and rebuild.
3. Capture the per-activity push token the app logs on start, then send an update:

   ```bash
   node scripts/push-update.mjs <push-token> 4          # advance to step 4
   node scripts/push-update.mjs <push-token> delivered  # end the activity
   ```

   The script reads your key path, Key ID, and Team ID from environment variables. Run it with no
   arguments to see the full usage.

### Android (FCM)

1. Create a **Firebase project**, add an Android app with the package `com.fasarticle.droptrack`
   (or change it in `app.json`), and download **`google-services.json`** to the repo root.
2. Download a **service-account JSON** (`fcm-service-account.json`) with the Firebase Messaging
   scope to the repo root.
3. Rebuild, capture the FCM registration token the app logs, and send a data-only push through the
   FCM client in `scripts/fcm.mjs`.

### The web dispatcher

For a friendlier loop than the CLI, run the local signing server and open the Expo-web console:

```bash
npm run dispatch          # starts the 127.0.0.1 signing server
npx expo start --web      # open the dispatcher console in the browser
```

The server holds your signing keys and never exposes them to the browser. Pick a delivery step, a
courier, and a target device, then fire a push.

## Credentials and safety

`google-services.json`, `fcm-service-account.json`, and any `.p8` key are gitignored. Keep them out
of version control. The push phases fail fast with a clear error if a required file is missing.

## License

MIT. See [`LICENSE`](./LICENSE).
