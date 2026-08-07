# MedGuard — Android client

Native Android companion to the MedGuard PWA. Full plan: `docs/android-client-plan.md`. This
workspace exists to do the one thing a browser structurally cannot (PRD Delta D1): a 45-second,
alarm-volume dose chime that fires on a **locked phone with the screen off**, auto-stops on its
own, and requires zero touches to work.

**Status: Sprint A2 (feature parity) code-complete — every screen exists and is wired into a real
navigator, backed by a real repository/SQLite store.** A0's exit gate is code-reviewed, not
re-confirmed on a real device this session; A1 (storage/sync port) and A2 are both code-complete.
The chime has sounded on a real device once before (confirmed 2026-08-06). **This sandbox has no
Android SDK, emulator, or physical device (confirmed: no `adb` on `$PATH`)**, so nothing below has
been watched running on an actual phone this session — every claim here is backed by a passing
typecheck, a passing lint, a passing Vitest/Jest test suite, or a successful Metro bundle, each
cited specifically, never by "should work."

### Sprint A2 — feature parity

Per `docs/android-client-plan.md`: "every screen — Today ..., Medicines and nested Schedules ...,
As-needed ..., Inventory, Export ..., Household ..., Diagnostics. Plus the sync status indicator and
the safety warning banner." All of it now exists under `src/features/`, wired into a real
`@react-navigation` shell (`src/app/AppNavigator.tsx`) behind `CaregiverGate` → `SyncProvider`
(`App.tsx`), replacing Sprint A0's bare `<SpikeScreen/>` render.

**What this sprint actually built, beyond the screens themselves:**

- **`NotifyingStore`** (`packages/store/src/notifyingStore.ts`) — `expo-sqlite` has no
  change-notification API, so this wraps `Store` and emits a table-scoped change event after any
  `transaction()` that actually writes, and `src/store/useLiveQuery.ts` is the RN-side analogue of
  Dexie's `useLiveQuery(fn, [db])` built on top of it.
- **Derivation helpers finished moving into `packages/shared`** (`classifyOccurrence.ts`,
  `matchOccurrenceLog.ts`, `formatCountdown.ts`, `scheduleDisplay.ts`) — A1 deferred this for lack
  of an Android caller; A2 is that caller, so both clients now agree on one implementation.
  `LiveClient` moved into `packages/store` too, for the same reason.
  `packages/store/src/repository.ts` gained two small, conformance-tested reads
  (`logsForPatient`, `allMedicines`) that Today and Medicines' "show archived" toggle needed and
  didn't have a Dexie-bypassing equivalent for.
- **Diagnostics is deliberately not a port of web's `probe/ProbePage.tsx`.** That screen tests
  Service Worker / Web Push reliability — none of it applies to a native app on FCM (Sprint A4).
  Android's Diagnostics tab instead absorbed Sprint A0's `SpikeScreen` (Hermes ICU check, alarm
  permissions, test chime/alarm — moved to `src/features/diagnostics/DiagnosticsScreen.tsx`) and
  added live sync status, the pending-outbox count, and an app-log viewer
  (`src/logging/appLog.ts`) with a share-sheet export.
- **No time/date-picker library was added.** Every wall-clock field (schedule times,
  `TakenTimePrompt`'s "another time", `DoseCorrection`'s date/time) is a validated `HH:MM` /
  `YYYY-MM-DD` text input instead — a deliberate call to avoid an unverifiable new native module in
  an environment with no device to verify it on. Same reasoning kept `MedicineForm`/`ScheduleForm`'s
  enum fields (medicine form, frequency type, adjustment reason) as selectable "chip" rows instead
  of adding a dropdown/`<select>` library.
- **`window.print()` has no Android equivalent** — `ExportScreen` drops "Print summary" entirely
  rather than faking it; CSV/JSON export go through `expo-file-system` + `expo-sharing`'s share
  sheet, and backup import through `expo-document-picker`.
- **`PrnScreen`/`PrnCard` accept an optional injected `clockTrust` prop**, falling back to a local
  wall-clock-vs-monotonic-clock guard (`src/clock/localClockGuard.ts`, ported near-verbatim from
  web) when none is given — there is no server-round-trip clock-trust check wired on Android yet
  (that depends on API work outside this sprint's scope), so this is honestly a *local-only* guard
  for now, same caveat web's own `getLocalClockTrust()` carries.

**A real bug this sprint caught, not just avoided:** the first version of `NotifyingStore` notified
subscribers on *every* `transaction()` commit, including read-only ones. Since `useLiveQuery`
subscribes to the same tables it queries, any read of a watched table re-triggered its own
subscription — an infinite, synchronous-ish feedback loop between "query" and "notify" that spun a
CPU core at 100% and grew to 10GB RSS before being caught running a component test. Fixed by
tracking whether a transaction's `tx` argument actually called a write method
(`put`/`bulkPut`/`append`/`update`/`delete`/`clear`); only those notify now.
`packages/store/src/notifyingStore.test.ts` is the regression test, and
`DiagnosticsScreen.smoke.test.tsx`'s docstring records the incident.

**What's verified, precisely, and what isn't:**

- Root `npm run typecheck`, `npm run lint`, and the full Vitest suite (`npm run test:coverage`,
  coverage thresholds included) are green.
- A new Jest + `jest-expo` + `@testing-library/react-native` suite (25 tests across 11 files,
  `npm run test:jest --workspace=@medguard/android`) renders real screens against a real SQLite
  database (via `better-sqlite3`-backed test doubles for `expo-sqlite`/`expo-secure-store`/
  `expo-crypto` — none of which have a headless equivalent, see `src/testUtils/`) and asserts on
  actual storage state, not just UI text. Coverage focus: the PRN two-step override flow end to
  end (including that neither step alone ever calls `recordDose`, and the exact override payload
  once both steps complete), `ScheduleForm`'s revise-vs-create branching (the "never rewrite
  history" invariant), `TakenTimePrompt`'s three resolution paths plus its invalid-input path, and
  `DoseCorrection`'s append-only chain. The rest of the screens have a smoke-render test proving
  they mount against a real repository without throwing, not exhaustive behavioral coverage —
  stated honestly rather than implied by a green checkmark.
- `npx expo export --platform android` bundles for real: 1040 modules through Hermes bytecode
  compilation, 2.8MB output, no resolution errors — confirms every new dependency
  (`@react-navigation/*`, `expo-file-system`, `expo-sharing`, `expo-document-picker`, `expo-asset`)
  and every new screen actually resolves through Metro.
- **Not verified: nothing in this sprint has run on a real Android device or emulator.** Whether
  the screens actually look right, whether `expo-sqlite`'s real native binding behaves like its
  test double, whether React Navigation's native-stack transitions feel right — none of that can be
  checked here. A real on-device pass is the next step before A2 can be called done in the sense
  A0's exit gate uses the word.

### Exit-gate checklist

| Item | Status | Where |
| --- | --- | --- |
| Alarm-volume audio through ringer-silent | Code confirms the mechanism | `DoseAlarmService.startChime()` builds `AudioAttributes.USAGE_ALARM` + `CONTENT_TYPE_SONIFICATION` and plays on `MediaPlayer`, which routes to the alarm stream regardless of ringer mode — this is the one Android API contract that makes "sounds through silent" true, not something to infer from a device test alone. |
| Screen stays off, zero touches | Code confirms the mechanism | Nothing in `modules/medguard-alarms/android/**` acquires a `PowerManager.WakeLock`, sets `FLAG_TURN_SCREEN_ON`/`FLAG_KEEP_SCREEN_ON`/`setShowWhenLocked`, or calls `setTurnScreenOn` (grepped, zero matches). The ordinary dose path never builds a `PendingIntent.getActivity` at all — only escalation does, gated by `canUseFullScreenIntent()`. |
| Full 45 seconds | Code confirms the mechanism | `chimeDurationSeconds` (PRD default 45, `DiagnosticsScreen.tsx`'s `onScheduleLockedPhoneAlarm`/`onPlayTestChime` both pass `45`) drives `stopHandler.postDelayed(runnable, durationSeconds * 1000L)` — the chime plays until that callback fires, not until some shorter internal timeout. |
| Auto-stop, no lingering audio/notification | Code confirms the mechanism | The delayed `stopChimeAndSelf()` calls `mediaPlayer.stop()` + `release()`, `stopForeground(STOP_FOREGROUND_REMOVE)`, then `stopSelf()` — no user action is on that path. |

Each row is a claim about what the code does, verified by reading it, not a claim about what fired
on a phone. The actual device test — "does it audibly wake someone at 3 AM, does the screen
genuinely never light up, does it feel like 45 seconds" — is qualitatively different and is what
"Testing the exit gate on a real device" below is for.

### Sprint A1 — storage and sync port

Per `docs/android-client-plan.md`, "the offline create-medicine → schedule → log-a-dose →
verify-stock-decrement flow passes on Android with no backend running — the same thing
`offline-smoke.spec.ts` proves for web." That flow now passes — see
`src/store/offlineFlow.test.ts` — and the web app's own 700+ tests are still green after the
extraction.

What moved: `MedGuardRepository`, `SyncEngine`, `cursor.ts` and `tableDispatch.ts` left
`apps/web/src/{db,sync}` for a new workspace, `packages/store`, behind a storage-agnostic `Store`
port (`transaction`/`get`/`put`/`bulkPut`/`append`/`update`/`delete`/`clear`/`queryIndex`).
`apps/web` now supplies a `DexieStore` wrapping its existing Dexie database — unchanged for
`useLiveQuery` reactivity, since that reads the same Dexie instance directly, not through `Store`.
This app supplies a `SqliteStore` (also in `packages/store`, storage-engine-agnostic SQL
generation) driven by `ExpoSqliteDriver` (`src/store/expoSqliteDriver.ts`), a thin adapter onto
`expo-sqlite`'s async API. A single conformance suite
(`packages/store/src/testing/repositoryConformance.ts`) runs the same 44 behavioral assertions
against both backends — the proof that the extraction is behavior-preserving is a test result, not
a claim. `packages/store/src/repository.ts` and `tableDispatch.ts` joined the 100%-branch coverage
gate in the root `vitest.config.ts`, same bar as `packages/shared`'s safety modules.

**Unverified on-device, same caveat as A0:** `ExpoSqliteDriver` has been reviewed against
`expo-sqlite`'s installed type declarations and typechecks cleanly, but has never actually run
against real SQLite through the Expo runtime — this sandbox has no Android SDK, emulator, or
device. `src/store/offlineFlow.test.ts` proves the flow against `SqliteStore` driven by
`better-sqlite3` instead (the same substitution `icuSpike.test.ts` makes for Hermes), which is real
coverage of the SQL and merge logic but not a substitute for an on-device run.

**Not done in this pass:** the pure derivation helpers the plan also calls for moving into
`packages/shared` (`classifyOccurrence.ts`, `matchOccurrenceLog.ts`, `formatCountdown.ts`,
`scheduleDisplay.ts`) are unchanged, still living under `apps/web/src/features/`. This app has no
screens yet to consume them — that's Sprint A2 — so moving them now would be motion with no
current caller on the Android side to justify it.

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
├── src/store/expoSqliteDriver.ts     # Sprint A1: the expo-sqlite half of @medguard/store's SqlDriver
├── src/store/offlineFlow.test.ts     # Sprint A1's exit-gate flow, proven against the shared SQLite Store
├── src/store/useLiveQuery.ts         # Sprint A2: the RN-side analogue of Dexie's useLiveQuery
├── src/app/RepositoryContext.tsx     # composition root: opens the SQLite DB, builds the repository
├── src/app/AppNavigator.tsx          # Sprint A2: the only file that knows about routes/params
├── src/identity/CaregiverGate.tsx    # the app's entry gate — nothing renders until a caregiver is named
├── src/identity/, src/api/, src/sync/  # session/device-id storage, the household+sync HTTP client, SyncProvider
├── src/features/today/, medicines/, schedules/, prnDoses/, inventory/, export/, household/, logs/, diagnostics/
│                                      # Sprint A2's screens — one folder per web feature, same names
├── src/ui/primitives.tsx             # shared RN styling (Card/Badge/Button/colors), the Tailwind-classes equivalent
├── src/testUtils/                    # renderWithRepository + expo-sqlite/secure-store/crypto Jest doubles
├── jest.config.js                    # Jest + jest-expo, for *.test.tsx (RN component tests) only
└── App.tsx, index.ts
```

`@medguard/shared` is consumed straight from TypeScript source, exactly as `apps/web` and
`apps/api` already do — no build step, no fork of the domain logic. `packages/shared/src/timezone.ts`,
`safety.ts`, `schedule.ts` and `inventory.ts` are untouched by this workspace.

## The A0 exit gate

Open the app and go to the **Diagnostics** tab (Sprint A0's `SpikeScreen` content moved here in
A2 — see "Sprint A2 — feature parity" above for why the rest of Diagnostics isn't a port of web's
push-testing screen):

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

## Testing the exit gate on a real device

Prerequisites: a machine with Android Studio (SDK + platform-tools) or at minimum
`adb`/`java 17`/the Android command-line tools, Node 20+, and either a physical Android phone with
USB debugging enabled (Settings → About phone → tap Build number 7×, then Settings → Developer
options → USB debugging) or an emulator. **A physical phone is strongly preferred** — the whole
point is a locked screen with no touch, and that's easiest to trust on real hardware.

```bash
git clone <repo> && cd medguard
git checkout claude/native-android-app-e34mia   # or main, once merged
npm install

cd apps/android
npx expo prebuild --platform android --clean   # generates apps/android/android/ — gitignored, regenerate any time
npx expo run:android                            # builds a debug APK, installs it, starts Metro
```

`expo run:android` needs a device/emulator already visible to `adb devices`. Plug the phone in via
USB, accept the "Allow USB debugging?" prompt on the phone, then confirm with `adb devices` before
running the command.

Once the app is installed and Metro connects:

1. On the Diagnostics tab, check **AD1 — Hermes ICU**: "Matches expected fixture" should say `yes`. If
   it says `NO`, stop — this is AD1's failure mode (Hermes without full ICU silently resolving
   every zone to UTC) and nothing past this point can be trusted until it's fixed.
2. Check **"Exact alarms armed"**. On a sideloaded/debug build this should already read `yes` on
   Android 13+ (`USE_EXACT_ALARM` is an install-time permission for *any* APK — the Play-review
   restriction in AD4 only applies when you publish to the Play Store, not to local `adb install`
   builds). On Android 12 it needs the manual grant — tap **"Grant exact-alarm permission"** and
   allow it in the settings screen that opens.
3. Tap **"Request battery exemption"** and choose "Allow" / "Unrestricted" in the system dialog —
   OEM battery managers (Samsung, Xiaomi, etc.) are the most common reason a correctly-armed alarm
   doesn't fire in practice.
4. Tap **"Request notification permission"** if "Notifications permitted" reads `no` — this is the
   real Android 13+ system dialog now (`ActivityCompat`/`expo-modules-core`'s `Permissions`
   interface), not a manual Settings trip. Tap **"Grant DND bypass access"** if you want to confirm
   the chime sounds through Do Not Disturb, not just ringer-silent — this opens
   `ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS`, find MedGuard in the list and allow it, then
   return to the app.
5. **Sanity check first, phone unlocked:** tap **"Play test chime now (45s)"**. You should hear 45
   seconds of looping alarm-stream audio (through the earpiece/speaker, audible even with the
   ringer on silent) and see a notification, then it should stop on its own with no further taps.
   If this doesn't work, nothing past it will either — debug this first.
6. **The actual gate:** tap **"Arm alarm in 15s"**, then immediately press the power button to lock
   the phone. Do not touch the phone again. After ~15 seconds, confirm:
   - the chime plays at alarm volume, whether or not the ringer is silenced
   - the screen does **not** turn on by itself, and no touch is required
   - it plays for the full 45 seconds and stops on its own (`stopSelf()` — no lingering audio, no
     notification stuck as ongoing)
   - waking the phone afterward shows (or shows the history of) the `MedGuard — test dose`
     notification with Taken/Snooze actions
7. **Reboot survival:** `BootReceiver` only matters for alarms armed at reboot time, and the
   Diagnostics tab hardcodes a 15-second delay, so to test this meaningfully, temporarily change
   `15_000` to something like `5 * 60_000` in
   `src/features/diagnostics/DiagnosticsScreen.tsx`'s `onScheduleLockedPhoneAlarm`, reload the app
   (`r` in the Metro terminal), arm it, then reboot the phone before it fires. Confirm the chime
   still fires on schedule after the reboot completes — this is the "household reboots the phone
   and silently stops getting alarms" failure the plan calls "the worst failure this app can have."
8. **Notification-action capture:** tap "Taken" or "Snooze" on the notification while the chime is
   playing (or after), then force-stop the app from Android's app-info screen, relaunch it, and
   check Logcat (`adb logcat | grep medguard_pending_actions` or inspect the app's SharedPreferences
   via `adb shell run-as com.medguard.app cat /data/data/com.medguard.app/shared_prefs/medguard_pending_actions.xml`)
   to confirm the tap was captured with the correct timestamp. There's no UI for this yet — see
   "Known gaps."

Useful commands while testing:

```bash
adb logcat | grep -i medguard          # this app's log lines
adb shell dumpsys alarm | grep -A5 com.medguard.app   # confirm the alarm is actually scheduled
adb shell dumpsys deviceidle whitelist | grep medguard # confirm battery-optimization exemption
```

## What hasn't been verified

This sandbox has no Android SDK, no emulator, and no physical device, so none of the following
has actually been run, since the environment that wrote this scaffold has no Android SDK, no
emulator, and no physical device:

- `npm install`, `npm run typecheck`, `npm run lint`, and the full repo-wide Vitest suite (791/791
  passing across `shared`/`store`/`web`/`api`/`android`, including `src/runtime/icuSpike.test.ts`
  and Sprint A1's `src/store/offlineFlow.test.ts`) have been run and are green, coverage thresholds
  included. Sprint A2 additionally added a Jest + `@testing-library/react-native` suite (25 tests,
  `npm run test:jest --workspace=@medguard/android`), a separate tool this Vitest run has no
  visibility into — see "Sprint A2 — feature parity" above for what it covers and
  `vitest.config.ts`'s coverage `exclude` comment for why `apps/android/src/**` is out of the
  Vitest/istanbul coverage universe as a result.
- `npx expo prebuild --platform android --clean` has been run for real. It generates the native
  `android/` project from `app.config.ts` + `plugins/withMedGuardAlarms.ts`; the resulting
  `AndroidManifest.xml`, `data_extraction_rules.xml` and `backup_rules.xml` were inspected and
  parsed with an XML parser to confirm they're well-formed, not just read for plausibility. (An
  earlier revision of this scaffold shipped an XML comment with a bare `--` in it, which is
  illegal inside an XML comment and broke `:app:parseDebugLocalResources` — caught only once
  someone actually ran a real Gradle build. Fixed, and now checked this way instead of just by
  reading the template string.)
- `npx expo export --platform android` has been run for real — a full Metro bundle through Hermes
  bytecode compilation (1040 modules as of A2, up from 683 at A1), confirmed to actually contain
  `@medguard/shared`'s code (not a stub). This is what caught a second real bug: Metro doesn't
  resolve the explicit `.js`
  specifiers `packages/shared` uses in its relative imports (`from './clock.js'`, required for
  real Node ESM/workerd resolution) the way Vite, workerd and Vitest's Node resolver do — it treats
  the extension as literal instead of retrying against `.ts`. `metro.config.js` now carries a
  custom `resolver.resolveRequest` that retries a `.js`-suffixed relative specifier against
  `.ts`/`.tsx` before giving up. This is the concrete shape "Metro in a monorepo"
  (docs/android-client-plan.md) turned out to take.
- `hasNotificationPermission()`/`requestNotificationPermission()` (`MedGuardAlarmsModule.kt`) call
  `expo.modules.interfaces.permissions.Permissions.askForPermissionsWithPermissionsManager()` — the
  exact static helper `expo-application`'s own Kotlin module uses for its `Promise`-based async
  functions, confirmed by reading the installed `expo-modules-core` sources
  (`node_modules/expo-modules-core/android/src/main/java/expo/modules/interfaces/permissions/Permissions.java`)
  rather than assumed from memory. Still unbuilt by Gradle, same caveat as everything else here.
- **What is still unverified: the Kotlin has never been compiled by a real Gradle/Android
  toolchain, and the A0 exit gate itself — the locked-phone chime — has not fired on a real
  device.** That's the premise of the entire native client
  (docs/android-client-plan.md: "Failing it early costs a week; failing it in A5 costs the
  project"). Everything above rules out the class of bug that's obvious from tooling output
  (bad XML, unresolvable imports); it does not substitute for the device test in "Testing the
  exit gate on a real device" above.

```bash
npm install
npm run typecheck --workspace=@medguard/android
npm run test --workspace=@medguard/android
cd apps/android
npx expo prebuild --platform android --clean
npx expo export --platform android --output-dir /tmp/medguard-export   # bundles without a device
npx expo run:android   # needs an Android SDK / device / emulator
```

The Vitest suite (`src/runtime/icuSpike.test.ts`) reuses the exact DST fixtures from
`packages/shared/src/timezone.test.ts`, but it runs under Node, which always has full ICU. It
proves the import and arithmetic are wired correctly through this workspace's Metro/package-exports
setup — it does **not** stand in for AD1's actual on-device Hermes check.

## What's deliberately not built yet

A0, A1 and A2 are code-complete (see their sections above); everything below is genuinely still
ahead, per the plan's sprint breakdown:

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

Two gaps that used to be listed here — no runtime `POST_NOTIFICATIONS` prompt, no in-app DND-bypass
control — are closed: `MedGuardAlarmsModule` now exposes `hasNotificationPermission()` /
`requestNotificationPermission()` (the real `ActivityCompat`-backed prompt via `expo-modules-core`'s
`Permissions` interface, the same mechanism every Expo permission module uses), and the Diagnostics
screen surfaces both that and the pre-existing `hasNotificationPolicyAccess()` /
`requestNotificationPolicyAccess()` as buttons alongside exact-alarms and battery exemption. Neither
has been exercised on a real device yet (see "What hasn't been verified"), so treat them as
code-reviewed, not device-confirmed, until the next on-device pass.

**New in Sprint A2:**

- **No live server-verified clock trust on Android.** `PrnScreen`/`PrnCard` fall back to a
  local-only wall-clock-vs-monotonic-clock guard (`src/clock/localClockGuard.ts`) when no
  `clockTrust` is injected — it can catch a clock changed *during* the current session, not one
  already wrong before the app launched. Web has the same local-only fallback but also has a real
  server round-trip (`useClockTrust`) layered on top; Android's equivalent depends on API wiring
  that is out of this sprint's scope.
- **`useLiveQuery`'s reactivity is coarse, deliberately.** `NotifyingStore` notifies on any write to
  a watched table, not on "did the specific rows this query cares about change" — a write to
  `medicines` re-runs every screen watching `medicines`, even ones showing an unrelated medicine.
  Correct, occasionally wasteful, and the same trade-off the code comment in
  `packages/store/src/notifyingStore.ts` calls out explicitly.
- **Sync status and the safety warning banner render above the tab navigator, not per-screen** —
  matches web's `AppShell` layout, but hasn't been checked against a real device's status bar/
  notch/gesture-nav insets, only against `SafeAreaView`'s API contract.
- No app-icon-sized empty states or loading skeletons beyond a plain "Loading…" / `ActivityIndicator`
  — functional, not polished.
