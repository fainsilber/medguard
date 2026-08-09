# MedGuard — Android client

Native Android companion to the MedGuard PWA. Full plan: `docs/android-client-plan.md`. This
workspace exists to do the one thing a browser structurally cannot (PRD Delta D1): a 45-second,
alarm-volume dose chime that fires on a **locked phone with the screen off**, auto-stops on its
own, and requires zero touches to work.

**Status: Sprint A2 (feature parity) code-complete — every screen exists and is wired into a real
navigator, backed by a real repository/SQLite store.** A0's exit gate is code-reviewed; the chime
itself (the "Play test chime now" button) is confirmed firing on a real device (2026-08-06, and
again 2026-08-07's household-sync testing below) — the "Arm alarm in 15s" locked-phone path is
still not re-confirmed this session. A1 (storage/sync port) and A2 are both code-complete. **This
sandbox has no Android SDK, emulator, or physical device (confirmed: no `adb` on `$PATH`)**, so
nothing below has been watched running on an actual phone from inside a Claude Code session —
every claim made from in here is backed by a passing typecheck, a passing lint, a passing
Vitest/Jest test suite, or a successful Metro bundle, each cited specifically, never by "should
work." Real-device testing itself happens on the caregiver's own phone, off a sideloaded APK (see
"Option C" below), with findings reported back and fixed in the next session — that's exactly what
happened 2026-08-07: a caregiver installed the build, joined a household, and hit a real sync bug
(see "Sync and household join" below) that no amount of in-sandbox testing could have caught, since
it only reproduces against `expo-sqlite`'s real native connection.

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
| Auto-stop, no lingering audio | Code confirms the mechanism | The delayed `stopChimeAndSelf()` calls `mediaPlayer.stop()` + `release()`, then `stopForeground(STOP_FOREGROUND_DETACH)`/`stopSelf()` — no user action is on that path. The **notification** deliberately does not disappear with it — see below. |

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

**Now run against real SQLite through the Expo runtime, not just reviewed against types:** a
caregiver's device surfaced a real bug in `ExpoSqliteDriver` on 2026-08-07 — see "Sync and
household join" below. `src/store/offlineFlow.test.ts` still proves the create/schedule/log/
decrement flow against `SqliteStore` driven by `better-sqlite3` (the same substitution
`icuSpike.test.ts` makes for Hermes), which remains real coverage of the SQL and merge logic, but
it's no longer the only evidence this driver has ever touched a real device — `expoSqliteDriver.test.ts`
now also regression-tests the on-device failure mode directly, against a fake that models
`expo-sqlite`'s actual rejection behavior rather than `better-sqlite3`'s.

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

Three ways to get an installable build onto a phone. None of them requires an Android
SDK/Android Studio *and* a machine at hand simultaneously — pick whichever you have.

### Option A — EAS Build (no Android SDK needed on your machine at all)

Builds remotely on Expo's servers and hands back a QR code / download link for a plain APK —
useful from a laptop with nothing but Node installed, or when you're away from your usual dev
machine. `apps/android/eas.json`'s `internal` profile is already configured for this
(`"buildType": "apk"`, `"distribution": "internal"`).

```bash
git clone <repo> && cd medguard   # main already has A0-A2 and the CI APK workflow
npm install -g eas-cli
cd apps/android
eas login              # free Expo account — https://expo.dev/signup if you don't have one
eas build --platform android --profile internal
```

Takes roughly 10–20 minutes. When it finishes, `eas build` prints a QR code and a URL —
scan the QR code with the phone's camera (opens the download directly) or open the URL on the
phone's browser, then tap the downloaded `.apk` to install (Android will prompt to allow installs
from that source the first time). **This cannot be run from inside a Claude Code sandbox session**
— the outbound network policy in that environment blocks `expo.dev`/`api.expo.dev` at the gateway
(confirmed: `CONNECT` to `api.expo.dev:443` returns a policy `403`), so this step needs a real
machine with unrestricted internet access. **Option C below is the sandbox-compatible equivalent**
— it can be triggered and monitored entirely through the GitHub API/MCP tools, no local machine or
Expo account needed.

### Option B — local build via Android Studio / the SDK command-line tools

Prerequisites: a machine with Android Studio (SDK + platform-tools) or at minimum
`adb`/`java 17`/the Android command-line tools, Node 20+, and either a physical Android phone with
USB debugging enabled (Settings → About phone → tap Build number 7×, then Settings → Developer
options → USB debugging) or an emulator. **A physical phone is strongly preferred** — the whole
point is a locked screen with no touch, and that's easiest to trust on real hardware.

```bash
git clone <repo> && cd medguard   # main already has A0-A2 and the CI APK workflow
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

### Option C — GitHub Actions (no Expo account, no local Android SDK needed)

Builds on a GitHub-hosted runner via a plain `expo prebuild` + Gradle build (`.github/workflows/android-apk.yml`,
`workflow_dispatch` only) — no Expo/EAS account, no secrets, nothing installed locally beyond a
browser. Good default when you just want an APK to sideload and don't need EAS's remote build farm
or OTA updates, and the only option that works from inside a Claude Code sandbox session (Option A
is blocked there — see above).

1. In the repo on GitHub, go to **Actions → Build Android APK → Run workflow**, and run it on the
   branch you want. (From a Claude Code session with GitHub MCP tools, trigger it directly via
   `mcp__github__actions_run_trigger` with `method: run_workflow`, `workflow_id: android-apk.yml`
   — no need to open the UI.)
2. When the run finishes, open it and download the **medguard-release-apk** artifact (a zip
   containing `app-release.apk`).
3. Transfer the unzipped `.apk` to the phone (e.g. download it directly on the phone's browser, or
   `adb install app-release.apk` over USB) and tap it to install — Android will prompt to allow
   installs from that source the first time.

This produces a `release`-variant APK, still debug-*signed* (same signing as `expo run:android` in
Option B — no real keystore is configured, so the RN template's `release` signingConfig falls back
to the debug key), suitable for sideloading/testing but not for a Play Store submission.

**The first real-device install (2026-08-07) surfaced bugs the CI run alone couldn't catch, all
now fixed:**

- **"Unable to load script"/red screen on launch, every time, including after Reload.** The
  workflow built `assembleDebug`. A `debug`-variant APK never embeds the JS bundle — it expects a
  Metro dev server reachable over `localhost:8081`/the LAN, which a sideloaded APK with no attached
  computer never has. Switched to `assembleRelease`, which runs Gradle's
  `bundleReleaseJsAndAssets` and embeds `index.android.bundle` into the APK's assets, so the app
  runs standalone. (This is also why "run #1" below, from before the fix, should not be treated as
  a working build — it launched, produced an artifact, and installed, but the app itself never
  actually started.)
- **Launcher icon was the stock Android/Expo default, not the Star of Life mark.** `app.config.ts`
  had no `icon`/`android.adaptiveIcon` entries, so `expo prebuild` fell back to Expo's template
  icon. Added `apps/android/assets/icon.png` and `adaptive-icon.png` (the same Star of Life PNGs
  `apps/web/public/icons/icon-512*.png` already uses) and wired them into `app.config.ts`.
- **Network calls (household create/join, sync) failed outright, once the app actually launched.**
  `app.config.ts`'s `extra.apiBaseUrl` fell back to `https://medguard-api.example.workers.dev` — a
  placeholder host that has never resolved — whenever `MEDGUARD_API_BASE_URL` wasn't set, which is
  always true for this CI workflow (it sets no env vars). `src/api/config.ts` already had the
  correct fallback (`https://medguard-api.fainsilber.workers.dev`, the real deployed worker), but
  it never ran, since the truthy placeholder from `app.config.ts` always took precedence. Fixed by
  leaving `extra.apiBaseUrl` `undefined` when the env var is unset, so `config.ts`'s real default
  is the only place that URL is hardcoded.
- **Bottom tab bar showed the same generic placeholder glyph ("⏷") on all seven tabs.**
  `AppNavigator.tsx` never set `tabBarIcon`, so `@react-navigation/bottom-tabs` fell back to its
  own `MissingIcon`. Added a `tabBarIcon` per tab using plain emoji `Text` glyphs — no new
  dependency, consistent with this app's existing avoidance of icon/dropdown libraries that can't
  be verified on-device from this sandbox.

**Verified working end-to-end (build+upload) 2026-08-07**: [run #1](https://github.com/fainsilber/medguard/actions/runs/31153170066)
off `main`, completed in ~11 minutes, produced a 57 MB `medguard-debug-apk` artifact — but per the
bugs above, the app inside it never actually launched, and even a rebuilt release APK would have
hit the dead API host next. A later, fixed build was installed and opened on a physical phone the
same day — see "Sync and household join" below for what that surfaced.
Note: `workflow_dispatch` workflows are only dispatchable once the workflow file exists on the
repo's **default branch** — a PR changing this file must be merged to `main` before the change can
be triggered.

### Sync and household join (real-device findings, 2026-08-07)

A caregiver installed the fixed build (above) and joined a household by code. The app log's own
share-sheet export (`DiagnosticsScreen`'s "Share log", now named `medguard-app-log-<timestamp>.txt`
instead of whatever generic name Android's plain-text share invented) showed sync failing on every
attempt with `NativeDatabase.execAsync` rejections — `cannot start a transaction within a
transaction` / `cannot rollback - no transaction is active`. Playing the test chime worked
throughout, and revoking a household member worked (that action doesn't touch local SQLite the same
way). Two distinct causes, found and fixed across two rounds against real device logs:

- **`SyncEngine.runOnce()` could be entered concurrently.** `SyncProvider` calls it from three
  independent triggers — mount, a new outbox entry, and the live socket reaching `'open'` — that
  can land in the same tick. Dexie/IndexedDB (web) tolerates the resulting overlapping
  `store.transaction()` calls; `expo-sqlite`'s single connection does not. Fixed by having
  `runOnce()` coalesce concurrent callers onto one run, with a caller that arrives mid-run waiting
  for a fresh rerun afterward rather than a stale one already in flight (`packages/store/src/syncEngine.ts`,
  `packages/store/src/syncEngine.test.ts`).
- **That alone didn't fix it — a second device log still showed the same error from a single,
  non-overlapping sync run.** Real cause: `NotifyingStore` fires every subscribed `useLiveQuery`
  refetch synchronously, but fire-and-forget, right after a write's transaction settles.
  `SyncProvider` and `DiagnosticsScreen` both watch `syncOutbox` — the exact table `drainOutbox()`
  writes on every synced entry — so that refetch's own `store.transaction()` call races the sync
  engine's *next* write on `expo-sqlite`'s single, unqueued native connection. Fixed at the driver
  level: `ExpoSqliteDriver.withTransaction()` (`src/store/expoSqliteDriver.ts`) now queues every
  transaction onto a private promise chain, so any two calls to `store.transaction()` from any call
  site — sync engine, a live query, a direct repository write — run strictly one at a time. This is
  the general fix; the `SyncEngine` coalescing above is a smaller, complementary win (fewer
  redundant sync rounds), not what actually stopped the crash. `expoSqliteDriver.test.ts` is the
  regression test, built against a fake `SQLiteDatabase` that models the real rejection behavior
  rather than `better-sqlite3`'s (which has no concept of it — see `sqliteTestDouble.ts`'s own
  comment on this, written before the bug was ever hit on a real device).

**Not yet re-confirmed**: the fixed driver has passing typecheck/lint/Vitest coverage (this
session's tooling) but, like everything else in this file, hasn't been watched syncing successfully
on the caregiver's actual phone yet — that needs a fresh build installed over the one that produced
the logs above.

### Locked-phone alarm, real-device findings (2026-08-08)

A caregiver ran the full A0 exit gate for real: sync confirmed clean (no transaction errors), the
alarm fired correctly through a locked, silenced phone. Two more findings:

- **The notification disappeared once the 45s chime auto-stopped, instead of staying available for
  Taken/Snooze.** Confirmed in `DoseAlarmService.kt`: `stopChimeAndSelf()` called
  `stopForeground(STOP_FOREGROUND_REMOVE)`, which deletes the foreground notification the instant
  the service stops — contradicting this very file's own manual-test script (step 6 above), which
  expects the notification to still be there afterward. Fixed: the notification is now re-posted as
  a plain, dismissible one (`setOngoing(false)`) immediately before `stopForeground(STOP_FOREGROUND_DETACH)`
  — the chime and foreground service still stop exactly as before, but Taken/Snooze survive for a
  caregiver who reaches the phone after the chime has already ended. Kotlin, so — same caveat as the
  rest of `modules/medguard-alarms/` — not compiled or run this session; code-reviewed only.
- **PRN "Clock unverified" gets stuck after any period the phone was actually locked.** Root cause
  traced into React Native itself: `performance.now()` (what `src/clock/localClockGuard.ts` used as
  its tamper-proof monotonic reference) is backed by `std::chrono::steady_clock`
  (`ReactCommon/react/timing/primitives.h`), which on Android maps to `CLOCK_MONOTONIC` — a clock
  that **stops advancing during real device sleep** (screen off, Doze), unlike `Date.now()`, which
  keeps advancing in real time. So any normal lock/unlock cycle longer than
  `CLOCK_SKEW_TOLERANCE_MS` (2 minutes) made the wall clock look like it had raced ahead of the
  "monotonic" one — indistinguishable, by the guard's own math, from a caregiver winding the clock
  forward — and since the guard deliberately never re-anchored mid-session (by design, so tampering
  couldn't just be waited out), once tripped it stayed tripped for the rest of the session. This
  made every guarded PRN medicine effectively unusable without an override on a phone that had ever
  been locked, which given this app's job description ("locked phone, screen off") is close to
  always. **Fixed**, with sign-off to implement given explicitly since this touches safety-critical
  dose-gating logic: a new native `elapsedRealtimeMs` export (`MedGuardAlarmsModule.kt`, backed by
  `SystemClock.elapsedRealtime()`) counts sleep time the same as `Date.now()` does, *and* — unlike
  `performance.now()` — can't be moved by a caregiver changing the system clock, since it isn't the
  system clock. `localClockGuard.ts` was reworked around it: a background refresh loop
  (`startLocalClockGuard()`, started once by `PrnScreen`) samples it on an interval and on every
  foreground resume, and — safely, only because this new clock source can't be spoofed the way
  `performance.now()` could — re-anchors after every reading, so normal sleep never accumulates into
  a false positive. `elapsedRealtimeMs` is mocked in `testUtils/mockMedguardAlarms.ts` for Jest; the
  Kotlin side is still unbuilt/unrun from this sandbox, same caveat as everything native here.

### Revoked-device data retention (real-device finding, 2026-08-08)

The same caregiver revoked one of their own devices from `HouseholdScreen`'s device list to test
the flow. It worked — the revoked device stopped syncing — but its local medical data (medicines,
schedules, logs) stayed on it indefinitely, since `deviceRoutes.delete('/:deviceId')`
(`apps/api/src/routes/devices.ts`) deletes only the server-side device row; nothing tells the
revoked device to clear anything, and it has no way to be told anything once its own token stops
working. Deliberately not auto-wiped on the first failed sync round — a caregiver's dosing history
disappearing without a confirmed action is its own kind of harm, and a 401 could in principle be
transient or misconfigured rather than a genuine revoke. Instead:

- `SyncApiResult`/`ApiResult` (`packages/store/src/syncEngine.ts`, `src/api/householdApi.ts`) now
  carry an optional raw server `code` alongside the existing translated `error` message, and
  `SyncEngine` throws a new `SyncApiError` (message + `code`) on a failed bootstrap/pull/push
  instead of a plain `Error` — so a caller can react to *which* failure this was instead of
  string-matching a human-facing message. Purely additive; web's `SyncApi` is unaffected.
  `syncEngine.test.ts` covers the `code` surviving the throw for both `drainOutbox()` and `pull()`.
- `SyncProvider` now has a distinct `'revoked'` status (`SyncStatusBadge` shows "Removed") when a
  sync round fails with `code: 'unauthorized'`, separate from the generic `'error'` status a
  transient failure gets — and a new `RevokedDeviceBanner`, rendered alongside
  `SafetyWarningBanner`, explains what happened and offers a two-step "Clear local data" confirm
  (mirroring `PrnCard`'s override flow's care around a destructive action) that wipes local data
  and forgets the session, the same effect as `HouseholdScreen`'s "Leave" but usable when this
  device's own token no longer works well enough to call `leaveHousehold()` first.

Not yet re-confirmed on an actual revoked device — the sync half of this (`SyncApiError`) has
passing Vitest coverage; the Android-side banner/status wiring passed typecheck, lint, and the
existing Jest suite unchanged, but has no dedicated component test yet and hasn't been watched
firing on a real 401 from a real revoked token.

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
- **What is still unverified: the full locked-phone A0 exit gate — "Arm alarm in 15s," screen off,
  zero touches, auto-stop — has not been confirmed firing on a real device this way.** The Kotlin
  *has* now been compiled by a real Gradle/Android toolchain (Option C's CI workflow, `assembleRelease`)
  and installed and launched on a physical phone (2026-08-07, "Sync and household join" above), and
  the "Play test chime now" button on that install did play alarm-stream audio on the device — but
  that's the always-visible, phone-unlocked sanity check, not the locked-phone gate itself. That's
  still the premise of the entire native client
  (docs/android-client-plan.md: "Failing it early costs a week; failing it in A5 costs the
  project") and still needs its own confirm — "Testing the exit gate on a real device" above.

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
