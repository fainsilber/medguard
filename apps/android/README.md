# MedGuard — Android client

Native Android companion to the MedGuard PWA. Full plan: `docs/android-client-plan.md`. This
workspace exists to do the one thing a browser structurally cannot (PRD Delta D1): a 45-second,
alarm-volume dose chime that fires on a **locked phone with the screen off**, auto-stops on its
own, and requires zero touches to work.

**Status: Sprint A0 — spike and scaffold.** Per the plan, "nothing else is built until it passes."
This commit is the scaffold and the native alarm layer the gate depends on; the gate itself (a
real chime, on a real locked phone) has **not** been run — see "What hasn't been verified" below.

## What's here

```
apps/android/
├── app.config.ts, metro.config.js, babel.config.js, eas.json, tsconfig.json, vitest.config.ts
├── plugins/withMedGuardAlarms.ts     # every manifest permission/receiver/service, in one file
├── modules/medguard-alarms/          # the local Expo module — the only part that has to be Kotlin
│   ├── src/                          #   TS surface: scheduleDoseAlarm, playTestChime, permission checks
│   └── android/src/main/java/com/medguard/alarms/
│       ├── AlarmScheduler.kt         #   AlarmManager.setAlarmClock() wrapper
│       ├── AlarmReceiver.kt          #   fires when the alarm goes off, starts the service
│       ├── DoseAlarmService.kt       #   foreground service: posts the notification, plays the chime
│       ├── MedGuardChannels.kt       #   versioned notification channels
│       ├── BootReceiver.kt           #   re-arms alarms after reboot / clock change
│       ├── NotificationActionReceiver.kt  # captures Taken/Snooze taps durably (app may be dead)
│       ├── PendingActionStore.kt     #   durable landing spot for captured taps (AD2)
│       ├── ArmedAlarmStore.kt        #   local mirror of "what's armed", for BootReceiver
│       └── MedGuardAlarmsModule.kt   #   Expo Modules API bridge
├── src/runtime/deviceRuntime.ts      # the only ambient-time/id edge in this app
├── src/features/spike/SpikeScreen.tsx # the A0 exit-gate screen (see below)
└── App.tsx, index.ts
```

`@medguard/shared` is consumed straight from TypeScript source, exactly as `apps/web` and
`apps/api` already do — no build step, no fork of the domain logic. `packages/shared/src/timezone.ts`,
`safety.ts`, `schedule.ts` and `inventory.ts` are untouched by this workspace.

## The A0 exit gate

Open the app and use the **SpikeScreen** (currently the whole app — feature parity is Sprint A2):

1. **AD1 — Hermes ICU.** The screen resolves `Asia/Jerusalem 2026-01-15 08:00` through
   `@medguard/shared`'s real `resolveLocal()` on-device and checks it against the known-correct
   UTC instant. If this is ever wrong on a real device, the fix is enabling the ICU-enabled Hermes
   variant or shipping a tzdata shim — **never** reimplementing `timezone.ts` (AD1).
2. **"Play test chime now"** — fires the real `DoseAlarmService` immediately: posts a
   notification, plays 45 seconds of looping audio on the alarm stream, auto-stops.
3. **"Arm alarm in 15s"** — the actual mechanism a dose alarm uses: a real
   `AlarmManager.setAlarmClock()` call 15 seconds out. Lock the phone immediately after tapping.
   The exit gate is this firing — at alarm volume, phone locked, screen off, zero touches — and
   auto-stopping on its own.

## What hasn't been verified

This sandbox has no Android SDK, no emulator, and no physical device, so none of the following
has actually been run:

- `npm install` has not been executed for this workspace (Expo/React Native installs are large;
  doing it here wouldn't let anything build anyway with no SDK present). Package versions were
  pinned against the real Expo SDK 57 registry metadata (`bundledNativeModules.json`), not
  guessed, but a fresh `npm install` at the repo root is the first real step and may surface
  version conflicts this review couldn't catch.
- `expo prebuild` has never generated the native `android/` project from
  `app.config.ts` + `plugins/withMedGuardAlarms.ts`, so the config plugin's manifest mutations are
  unverified beyond a careful reading of the `@expo/config-plugins` API.
- The Kotlin in `modules/medguard-alarms/android` has never been compiled. It's written to the
  real Android/AndroidX APIs (`AlarmManager`, `NotificationCompat`, `MediaPlayer`,
  `ContextCompat.startForegroundService`) as they're documented, but a real Gradle build is the
  first thing that will actually type-check it.
- **The A0 exit gate itself — the locked-phone chime — has not fired on a real device.** This is
  the premise of the entire native client (docs/android-client-plan.md: "Failing it early costs a
  week; failing it in A5 costs the project"). Don't treat this scaffold as proof the gate passes.

Run, at minimum, before trusting any of this:

```bash
npm install
npm run typecheck --workspace=@medguard/android   # TS surface + config plugin
npm run test --workspace=@medguard/android         # ICU/DST fixtures under Vitest (see caveat below)
cd apps/android && npx expo prebuild --platform android --clean
npx expo run:android   # needs an Android SDK / device / emulator
```

The Vitest suite (`src/runtime/icuSpike.test.ts`) reuses the exact DST fixtures from
`packages/shared/src/timezone.test.ts`, but it runs under Node, which always has full ICU. It
proves the import and arithmetic are wired correctly through this workspace's Metro/package-exports
setup — it does **not** stand in for AD1's actual on-device Hermes check.

## What's deliberately not built yet

Everything past the A0 gate, per the plan's sprint breakdown:

- **A1** — `packages/store` extraction (storage-agnostic `Store` interface, SQLite-backed
  implementation, conformance suite against both Dexie and SQLite). This app currently has no
  local database at all.
- **A2** — feature parity: Today, Medicines/Schedules, As-needed, Inventory, Export, Household,
  Diagnostics.
- **A3** — the full local alarm engine: horizon materialization from synced schedules, the
  Taken/Snooze → `pending_actions` → Headless JS → `recordDose()` path (the Kotlin side of that,
  `PendingActionStore`/`NotificationActionReceiver`, is built; the JS-side headless drain that
  runs with the app process dead is not — `drainPendingActions()` today only runs when the app is
  foregrounded), bounded snooze, "alarms unarmed"/"sync stale" degradation states.
- **A4** — server Sprint 5: the FCM sender, `dispatch.ts`, the DO dose-alarm chain, escalation,
  `DoseSnooze`, missed-dose sweep, low-stock push, probe-route removal. None of this exists on the
  API side yet, so a scheduled alarm currently has no server backstop.
- **A5** — Shabbat on native.
- **A6** — Play Console restricted-permission review, EAS CI wiring, accessibility pass.

## Known gaps in this scaffold, called out rather than hidden

- Chime audio uses the device's default alarm ringtone (`RingtoneManager.TYPE_ALARM`) rather than
  a custom-designed MedGuard tone. The plan's channel table calls for a "custom 45s chime" on the
  Shabbat channel specifically — that's a real audio asset someone needs to supply and drop into
  `modules/medguard-alarms/android/src/main/res/raw/`, then wire into `DoseAlarmService`.
- `MedGuardAlarmsModule.drainPendingActions()` exists and the native capture path is real and
  durable, but nothing calls it automatically yet — no headless task, no foreground-time drain
  wired into a repository. A tap today is captured safely and sits in `PendingActionStore` until
  Sprint A3 wires the drain.
- No app icon / splash asset — `app.config.ts` omits `icon`/`splash` and Expo will use its
  placeholder default until real assets exist.
