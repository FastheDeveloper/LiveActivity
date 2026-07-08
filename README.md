# DropTrack — React Native Live Activity demo (iOS + Android)

A mock delivery-tracker demonstrating:

- **iOS Live Activity** (ActivityKit + WidgetKit): lock-screen card + Dynamic Island with a
  segmented progress bar, driven from React Native buttons, updatable via APNs push.
- **Android Live Update** (`Notification.ProgressStyle`, Android 16 / API 36): the same
  delivery flow as a promoted ongoing notification with status-bar chip.

Built as the companion repo for a technical article — see `DEVLOG.md`, `GOTCHAS.md`, and
`ARTICLE_NOTES.md`.

## Prerequisites

- macOS with Xcode 26+ (built on 26.3), iOS 18+ simulator (Dynamic Island preview) or an
  iPhone 14 Pro+ on iOS 16.2+.
- Android SDK with **API 36** platform + an API 36 emulator (Live Updates floor).
- Node 20+, JDK 17.
- Paid Apple Developer membership only for the push-update phase (Phase 4).

## Run it

```bash
npm install
npx expo prebuild
npx expo run:ios       # or: npx expo run:android
```

(Reproduction steps, demo walkthrough, and known limitations are filled in as phases complete.)

## Status

- [x] Phase 0 — scaffold + config (Expo SDK 57, RN 0.86)
- [ ] Phase 1 — static Live Activity UI
- [ ] Phase 2 — driven from RN buttons
- [ ] Phase 3 — realistic state model + polish
- [ ] Phase 4 — APNs push updates
- [ ] Phase 5 — docs finalization
- [ ] A1–A5 — Android Live Updates track
