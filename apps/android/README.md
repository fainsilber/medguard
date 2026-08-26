# MedGuard — Android client

Native Android companion to the MedGuard PWA. Full plan: `docs/android-client-plan.md`. This
workspace exists to do the one thing a browser structurally cannot (PRD Delta D1): a 45-second,
alarm-volume dose chime that fires on a **locked phone with the screen off**, auto-stops on its
own, and requires zero touches to work.

**Status: Sprint A4 (the server alarm chain and the push backstop) code-complete 2026-08-09, not
yet device-confirmed** — see "Sprint A4" below; Sprint A3's local alarm engine is likewise
code-complete and awaiting the same real-device pass. A0's locked-phone exit gate fired correctly on a real device 2026-08-08; A1
(storage/sync port) and A2 (feature parity) are code-complete and real-device-tested up through
household join and sync. Continued real-device use since A0 found and fixed several bugs:
revoked-device data retention, the on-screen keyboard overlapping focused text fields (every
form/text-input screen now wraps in a shared `KeyboardAvoidingScreen`), and the app gained a
"Build" card on Settings showing the git SHA and build timestamp baked in at `expo prebuild`
time (mirrors `apps/web/src/version.ts`; see root `CLAUDE.md`'s build-identity convention).

**This sandbox has no Android SDK, emulator, or physical device (confirmed: no `adb` on `$PATH`)**, so
nothing below has been watched running on an actual phone from inside a Claude Code session —
every claim made from in here is backed by a passing typecheck, a passing lint, a passing
Vitest/Jest test suite, or a successful Metro bundle, each cited specifically, never by "should
work." Real-device testing itself happens on the caregiver's own phone, off a sideloaded APK (see
"Option C" below), with findings reported back and fixed in the next session — that's exactly what
happened 2026-08-07: a caregiver installed the build, joined a household, and hit a real sync bug
(see "Sync and household join" below) that no amount of in-sandbox testing could have caught, since
it only reproduces against `expo-sqlite`'s real native connection.

## Running the tests

```bash
npm run test:jest --workspace=@medguard/android          # RN screens/components (Jest + jest-expo)
npx vitest run --project android                          # pure/native-free alarm logic (Vitest)
cd apps/android && npx expo prebuild --platform android && cd android && ./gradlew :medguard-alarms:testDebugUnitTest   # Kotlin (Robolectric)
```

Maestro/adb flows against a real emulator or device live in `.maestro/` and `e2e/` — see
[`docs/testing.md`](../../docs/testing.md) for the full picture across every layer, including what
each one proves and doesn't.

### Sprint A4 — the push backstop and the headless drain

**Code-complete (2026-08-09), not device-confirmed.** Most of A4 is server work
(`apps/api`, see `docs/android-client-plan.md`'s A4 section); what lands in *this* workspace is the
receiving half plus the `HeadlessJsTaskService` A3 deliberately deferred.

**What the server now sends, and why this app needs it at all.** The local alarm is still primary:
only it plays the 45-second chime, and only it works with no signal. The push covers the two cases
a phone structurally cannot cover for itself — an **escalation** (a device cannot know whether
*another* caregiver acknowledged, so only the household's Durable Object can decide to send one),
and an **unarmed device** (exact alarms denied, notifications off, an OEM battery manager, the
phone simply switched off when the dose was due).

**`MedGuardMessagingService`** receives the data-only message and posts the notification. Data-only
matters: with a `notification` block Android composes and posts the alert itself while the app is
backgrounded, which means the wrong channel, no Taken/Snooze, and — on Shabbat — action buttons
that must never exist (D5). Composition moved into a new `DoseNotifications` shared with
`DoseAlarmService`, so a server alert and a local alarm are indistinguishable to a caregiver: same
actions, same channel rules, same AD4 full-screen-intent handling for escalation. The notification
id is derived from the `occurrenceKey`, which is what makes a late push *replace* the local
notification rather than stack a second one beside it. **No chime is started from a push** — the
chime belongs to the local alarm, and a device on this path is one whose local alarms are not
firing, so it gets its channel's sound. Honest degradation rather than a pretend chime.

**`MedGuardHeadlessService`** closes A3's known gap. A3 drained pending actions on app launch, on
`AppState` → `'active'`, and on the native `onPendingAction` event — all of which need a JS runtime
that already exists. A tap made with the process genuinely dead waited for the next app open. That
cost only latency until A4; now it can cost a spurious escalation to the second caregiver for a
dose that *was* given. `NotificationActionReceiver` therefore starts a headless runtime whenever
`MedGuardAlarmsModule.hasLiveRuntime()` is false, and its JS task
(`src/alarms/headlessTask.ts`, registered as `MedGuardPendingActions` in `index.ts`) runs the same
`PendingActionApplier` the foreground path does. Kotlin still writes no `IntakeLog` (AD2). The task
deliberately does **not** sync: the record is durable and in the outbox, and pushing it needs the
session, a network round trip and retry handling inside a service Android may stop at any moment.

**Registration.** `src/alarms/pushRegistration.ts` sends the FCM token to
`POST /api/v1/devices/push` on every start (idempotent by design — Firebase rotates tokens without
telling the app) and again whenever the new `onPushToken` event fires. Both the POST and the token
read are injected, because `householdApi.ts` pulls in `expo-device` and through it React Native,
which the Vitest project cannot load — the same discipline `AlarmEngine` applies to the native
surface, and it keeps every branch testable off-device.

**Firebase is optional, everywhere.** `plugins/withMedGuardAlarms.ts` adds the Google Services
Gradle plugin and the `MedGuardMessagingService` manifest entry **only when a
`google-services.json` is present**; `firebase-messaging` itself is a plain module dependency so
the Kotlin compiles either way. Without the file, `getPushToken()` returns null, no credential is
registered, and `alarmHealth` reports `no_server_backstop` — a **risk**, not a blocker, because
local alarms are unaffected. This is what keeps `.github/workflows/android-apk.yml` (a
GitHub-hosted runner with no secrets) producing a working sideloadable APK. Both paths were
verified by running `expo prebuild` with and without the file and reading the generated manifest
and Gradle files.

`FOREGROUND_SERVICE_SHORT_SERVICE` is declared alongside the existing permissions: Android 14+
requires one per foreground-service *type*, and without it the headless service throws on start —
silently losing the tap it exists to rescue.

**To turn the backstop on** (both halves are needed, and neither is in this repo):

1. Create a Firebase project, add an Android app with this package name, download
   `google-services.json` into `apps/android/` (gitignored). `app.config.ts` picks it up
   automatically — it sets `android.googleServicesFile` only when the file is actually there,
   which is what makes prebuild copy it into the generated `android/app/`. Declaring the path
   unconditionally would instead make prebuild throw for everyone without a Firebase project.
2. Firebase console → Project settings → Service accounts → generate a private key, then
   `cd apps/api && npx wrangler secret put FCM_SERVICE_ACCOUNT` and paste the whole JSON.

For a **CI-built APK** with the backstop, add the same `google-services.json` contents as a
GitHub Actions repository secret named `GOOGLE_SERVICES_JSON`; `.github/workflows/android-apk.yml`
writes it back to disk before prebuild. Leave the secret unset and the workflow builds the
local-alarms-only APK exactly as before.

**Tests:** `src/alarms/pushRegistration.test.ts` and additions to `alarmHealth.test.ts` here; the
substance is server-side in `apps/api/tests/alarms.test.ts` (the chain, the escalation boundary
asserted as an exact instant, snooze deferral, the missed sweep, low stock), `fcm.test.ts` (the
RS256 assertion verified against its own public key, data-only message shape, token caching, expiry
classification) and `dispatch.test.ts`. **Nothing on this list proves the Kotlin**: there is no
Android SDK in this sandbox, so `MedGuardMessagingService`, `MedGuardHeadlessService` and
`DoseNotifications` are backed by review and by the two `expo prebuild` runs, not by a compile.
That is the single biggest thing a real device would tell us that this session cannot.

### Sprint A3 — the local alarm engine

**Code-complete, not device-confirmed.** A0/A2 already built more of the native (Kotlin) layer than
the plan's A3 scope assumed — `AlarmScheduler`, `AlarmReceiver`, `DoseAlarmService`, `BootReceiver`
and all five versioned channels were already real and working. What A3 actually closes is the
JavaScript half: `apps/android/src/alarms/` did not exist before this sprint, and nothing called
`drainPendingActions()` at all — a lock-screen "Taken" tap was captured durably in Kotlin and then
never became a dose.

**The engine.** `src/alarms/horizon.ts` (`materializeHorizon`) is the pure decision: every
`expandSchedules` occurrence over a rolling 48-hour window (matching the server's own window),
minus anything already logged (`findLogForOccurrence`, so a correction chain is respected), minus
archived medicines, with a snoozed occurrence's trigger moved to its deferral deadline instead of
its due time, capped at 64 armed alarms. `alarmReconciler.ts` (`diffAlarms`) diffs that against
what `MedGuardAlarms.listArmedAlarms()` says is actually armed — Kotlin's list is the source of
truth, not a JS-side mirror, because `BootReceiver` re-arms after a reboot and drops expired alarms
without JS ever seeing either event. `alarmHealth.ts` derives two things safety invariant 6 needs
said loudly: **blockers** (exact alarms or notifications denied — alarms will not fire) versus
**risks** (battery optimization, no DND access — alarms may be delayed, and AD7 is explicit these
cannot be granted programmatically, so the wording says "may," never "will"), and **staleness**
(no successful sync in 24h — a new `getLastSyncedAt`/`setLastSyncedAt` pair in
`packages/store/src/cursor.ts`, since nothing previously recorded "the last pull succeeded at T").
`AlarmEngine.ts` is the one impure orchestrator — `reconcile()` (coalesced the same way
`SyncEngine.runOnce()` is, for the identical reason: it's triggered by store notifications that
fire once per pulled record) and `applyPendingActions()`.

**The peek/ack redesign.** The plan called for `drainPendingActions()` — read-and-clear in one
call. Building the JS side surfaced why that's wrong: if the app is killed between reading a
captured tap and writing the resulting `IntakeLog` (a real risk — the drain runs at app startup,
exactly when Android is most willing to kill a process), the tap is gone with nothing on disk to
retry. `PendingActionStore.kt` now gives each entry a stable id and splits into `readPendingActions`
(non-destructive) / `ackPendingActions(ids)` (JS calls it only after the resulting record has
committed). `AlarmEngine.applyPendingActions()` also dedupes against an occurrence's existing log
before calling `recordDose()` — deliberately, since `recordDose()` is not idempotent, and the
peek/ack redesign makes a repeated read the normal case rather than an edge case.

**Drain triggers — the deliberate gap, closed in A4.** A `HeadlessJsTaskService` (the plan's
original design for "the app process is fully dead") was **not** built in A3; it was deferred to
A4, where the headless bootstrap gets built once and shared with the FCM data-message handler A4
needs regardless. It now exists — see "Sprint A4" above. A3
instead: drains on app launch, on `AppState` → `'active'`, and on a new native `onPendingAction`
event (`Events("onPendingAction")` on `MedGuardAlarmsModule`, wired from
`NotificationActionReceiver` to a live JS runtime when one exists) — which covers a merely-locked
phone with the app still resident in memory, arguably the common case. The gap this leaves: a tap
made with a genuinely dead process waits for the next app open. Within A3 alone this costs nothing
but latency (the tap timestamp is still exactly right); once A4's escalation exists, that window
can cost one spurious escalation to the second caregiver's phone for a dose that was actually
given. Accepted rather than closed now, to avoid building headless-bootstrap machinery twice.

**Snooze became data (delta AD5).** `DoseSnooze` ships as a full synced entity, not a local-only
stopgap: `packages/shared/src/types.ts` + `snooze.ts` (`MAX_SNOOZE_COUNT = 3`,
`deriveSnoozeState`, `buildDoseSnooze`), `packages/store` (`recordSnooze`/`snoozesForOccurrence`/
`recentSnoozes` on `MedGuardRepository`, both SQLite and Dexie schemas), and the server
(`apps/api/migrations/0003_alarms.sql`, `dose_snoozes` in `apps/api/src/sync/tables.ts` as
append-only — same reason `intake_logs` is: two caregivers snoozing the same dose concurrently must
both survive, and the bound becomes a row count rather than a counter to get wrong). **Deployment
ordering matters**: the API needs migrating and deploying before an A3 build reaches a phone, or
`doseSnoozes` pushes are rejected and the outbox blocks. `HouseholdSettings.snoozeMinutes` — present
since Sprint 3 but read by nothing — is now genuinely load-bearing, and its bootstrap default moved
from 15 to 20 minutes (`packages/shared/src/settings.ts`, shared with web) to match the signed-off
decision: three snoozes at 20 minutes is exactly AD6's 60-minute escalation window.
`TodayView.tsx`'s in-memory `snoozedUntil` `Map` (a reload used to clear it) is gone, replaced by a
`useLiveQuery` over `recentSnoozes` feeding the same `classifyOccurrence` call; the Snooze button
shows "Snoozed 3/3" and disappears once the bound is reached rather than silently no-op'ing.

**UI:** `AlarmHealthBanner.tsx` (mounted in `App.tsx` beside `SafetyWarningBanner`) renders the same
wording `describeAlarmStatus` composes for the native `sync_status_v1` ongoing notification, so a
caregiver sees one consistent explanation on the phone and in the shade. `AlarmSetupChecklist.tsx`
is the AD7 guided checklist — the four grantable permissions plus an explicit, honest paragraph
that Xiaomi/Huawei/Oppo/Samsung autostart managers have no API to request through at all — shared
between the banner (only appears when something's actually wrong) and Settings (always visible),
replacing what used to be Settings' own inline copy of the same four rows.

**Tests:** `packages/shared/src/snooze.test.ts` and additions to `schedule.test.ts` (100% branch,
same gate as `safety.ts`/`schedule.ts` — a snooze bug either leaves an alarm armed after dismissal
or defers a dose past when it should escalate); a snooze conformance group in
`packages/store/src/testing/repositoryConformance.ts` run against both Dexie and SQLite; server
round-trip tests for duplicate/concurrent snoozes in `apps/api/tests/sync.test.ts`; and
`apps/android/src/alarms/*.test.ts` (`horizon`, `alarmReconciler`, `alarmHealth`, `AlarmEngine` —
76 Vitest tests total in `src/alarms/`) plus Jest coverage for the banner and the persisted-snooze
UI (`AlarmHealthBanner.test.tsx`, additions to `TodayView.test.tsx`). One real bug the `AlarmEngine`
tests caught before a device could: reading schedules/medicines/logs/snoozes via `Promise.all`
inside `reconcile()` opened four concurrent `store.transaction()` calls, which `expo-sqlite`'s
single connection tolerates only because of the queue added in Sprint A2's "Sync and household
join" fix — but the `better-sqlite3` test double has no such queue and threw "cannot start a
transaction within a transaction" immediately. Fixed by reading sequentially; also the more
portable choice, since nothing in the `Store` port promises concurrent-transaction safety.

Full repo Vitest (926/926, including the 100%-branch coverage gate on the new `snooze.ts` and the
unchanged `repository.ts`/`tableDispatch.ts`), the Android Jest suite (12 files/31 tests), `npx expo
export` (1054 modules, up from A2's 1040), and `npx expo prebuild --platform android --clean` (the
generated manifest carries every alarm-layer component correctly — no new manifest entries were
needed this sprint) are all green. Not built: the plan's Robolectric/instrumented `androidTest`
layer — there's no Kotlin test harness in this repo and no Android SDK in this sandbox, so the
Kotlin changes (`PendingActionStore`'s peek/ack split, the `onPendingAction` event, `StatusNotifier`,
`AlarmScheduler.cancelAll`, the batch `armDoseAlarms`) are verified by `expo prebuild` parsing and
production-code review, not by an on-device or emulator run.

> **Update, 2026-08-16:** the paragraph above is preserved as it was written at the time (Sprint
> A3) rather than edited to fit later reality. Robolectric landed since, along with a Maestro e2e
> layer for the notification-action and boot-rearm paths — see [`docs/testing.md`](../../docs/testing.md)
> for how to run both, and what they do and don't prove. The instrumented `androidTest` layer was
> never built and is not planned; Robolectric plus Maestro cover what it would have without needing
> an emulator inside the Gradle job itself.

**What genuinely needs a real
device**: the sprint's actual exit gate — a 25-hour locked-phone dry run where every alert fires,
every one auto-stops, none repeats, zero touches — plus the lock-screen-tap-with-app-force-stopped
path, a reboot and a timezone change mid-schedule, and the three-snooze bound exercised from the
notification itself rather than from `TodayView`.

### A3 real-device findings (2026-08-09)

First on-device install of the A3 build (`77b9db0`) found two real bugs in the same session, both
via Settings' "Arm alarm in 15s" test button — the A0 mechanism demo that arms with a bare
device-generated UUID as its `occurrenceKey`, deliberately not a real one, since the button exists
to prove the chime fires, not to be acted on with Taken/Snooze.

- **A garbage `occurrenceKey` reaching `Snooze` wrote an unrecoverable outbox entry.** The 'taken'
  path in `AlarmEngine.applyOne()` already refused to log against a key that doesn't resolve to a
  real occurrence (`resolveOccurrence`, logged as "no occurrence for a captured action" — visible,
  harmless, exactly as designed). `recordSnoozeFor` had no equivalent guard: it wrote a `DoseSnooze`
  with whatever string it was given straight to the repository. The server's `pushSchema` validates
  the outer request shape (including `table`) before ever reaching the per-table `doseSnoozeSchema`
  that would normally catch a malformed `occurrenceId` and report it back as one `rejected` entry
  — but a request shape failure 400s the *entire batch* as `invalid_request`, which is exactly what
  the device showed ("Sync error", "Please check the details and try again", 2 pending outbox
  entries, retried identically forever with no way to clear them from the UI). Fixed by validating
  with the same `parseOccurrenceKey` check `resolveOccurrence` already uses, before writing —
  `recordSnoozeFor` now refuses and logs cleanly, mirroring 'taken'.
- **`applyPendingActions()` had no coalescing, unlike `reconcile()`.** The same app-log capture
  showed the identical "no occurrence" line twice, ~30ms apart, and two separate "alarms reconciled"
  passes — a cold launch triggered by tapping a notification fires the mount-time
  `applyPendingActions()` call and the resulting foreground `AppState` transition within
  milliseconds of each other, and nothing stopped both from reading the same not-yet-acked entries.
  Harmless here (both concurrent reads hit the same unresolvable key and produced the same clean
  refusal), but for a *real* 'taken' action the existing-log dedupe only closes the race if the
  first call's write commits before the second call's read — not guaranteed under concurrency.
  Fixed by giving `applyPendingActions()` the same `inFlight`-coalescing `reconcile()` already had.

Neither bug affected a real scheduled dose in this session — both were triggered exclusively by the
A0 test button's non-real `occurrenceKey`, and `AlarmEngine.test.ts` gained regression coverage for
both (a malformed-key snooze refusal that still acks the tap; a coalescing test asserting
`readPendingActions` is called once for two concurrent invocations). **Operationally load-bearing:**
this also reconfirmed the deployment-ordering warning in "Decisions taken for this plan" above —
`doseSnoozes` support has to be live on the API before an A3 build reaches a phone, or every snooze
push 400s. A pre-existing, un-touched-by-A3 gap this surfaced but did not fix: `SyncEngine.drainOutbox()`
treats a server-`rejected` record (one that will *never* succeed, no matter how many times retried)
the same as a transient failure — `markSyncFailed`, indefinite retry — rather than resolving it
like a `blocked` one. That is what leaves a genuinely invalid record (from any table, any sprint)
stuck showing "Sync error" forever with no self-healing path; worth a deliberate decision before
Sprint 5, since it's shared, already-deployed sync-engine behavior that both clients rely on, not
something to change unilaterally alongside an unrelated fix.

### Sprint A2 — feature parity

Per `docs/android-client-plan.md`: "every screen — Today ..., Medicines and nested Schedules ...,
As-needed ..., Inventory, Export ..., Household ..., Settings. Plus the sync status indicator and
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
- **Settings is deliberately not a port of web's `probe/ProbePage.tsx`.** That screen tests
  Service Worker / Web Push reliability — none of it applies to a native app on FCM (Sprint A4).
  Android's Settings tab instead absorbed Sprint A0's `SpikeScreen` (Hermes ICU check, alarm
  permissions, test chime/alarm — moved to `src/features/settings/SettingsScreen.tsx`) and
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
`SettingsScreen.smoke.test.tsx`'s docstring records the incident.

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
| Full configured length | Code confirms the mechanism | `chimeDurationSeconds` (60s weekday / 30s Shabbat, resolved by `chimeDurationSecondsFor()`; `SettingsScreen.tsx` reads the same configured value rather than a literal) drives the delayed stop callback — the chime plays until it fires, not until some shorter internal timeout. |
| Auto-stop, no lingering audio | **Unit-tested** (`ChimeSessionTest`) plus code review | `ChimeSession` decides when the shared sound ends; the delayed `stopEverything()` stops and releases the one player, then `stopForeground(STOP_FOREGROUND_DETACH)`/`stopSelf()` — no user action is on that path. This row was previously code-review-only and is where the multi-alarm bug below hid. The **notification** deliberately does not disappear with it — see below. |

Each row is a claim about what the code does, verified by reading it, not a claim about what fired
on a phone. The actual device test — "does it audibly wake someone at 3 AM, does the screen
genuinely never light up, does it feel like the configured length" — is qualitatively different and is what
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
│       ├── PendingActionStore.kt     #   Sprint A3: peek/ack (readAll/ack), never a destructive drain
│       ├── ArmedAlarmStore.kt        #   local mirror of "what's armed", for BootReceiver
│       ├── StatusNotifier.kt         #   Sprint A3: the ongoing sync_status_v1 "alarms unarmed"/"stale" notification
│       └── MedGuardAlarmsModule.kt   #   Expo Modules API bridge, incl. Sprint A3's onPendingAction event
├── src/alarms/                       # Sprint A3: the JS alarm engine — see "Sprint A3" above
│   ├── horizon.ts                    #   materializeHorizon — pure: synced data -> what should be armed
│   ├── alarmReconciler.ts            #   diffAlarms — pure: armed-now vs. should-be-armed
│   ├── alarmHealth.ts                #   deriveAlarmHealth/deriveSyncStaleness/describeAlarmStatus
│   ├── AlarmEngine.ts                #   the one impure orchestrator: reconcile() / applyPendingActions() / snooze()
│   ├── AlarmProvider.tsx             #   React wiring — mount point, AppState/store/event listeners
│   ├── AlarmHealthBanner.tsx         #   safety invariant 6, in-app
│   └── AlarmSetupChecklist.tsx       #   AD7's guided checklist, shared with Settings
├── src/runtime/deviceRuntime.ts      # the only ambient-time/id edge in this app
├── src/store/expoSqliteDriver.ts     # Sprint A1: the expo-sqlite half of @medguard/store's SqlDriver
├── src/store/offlineFlow.test.ts     # Sprint A1's exit-gate flow, proven against the shared SQLite Store
├── src/store/useLiveQuery.ts         # Sprint A2: the RN-side analogue of Dexie's useLiveQuery
├── src/app/RepositoryContext.tsx     # composition root: opens the SQLite DB, builds the repository
├── src/app/AppNavigator.tsx          # Sprint A2: the only file that knows about routes/params
├── src/identity/CaregiverGate.tsx    # the app's entry gate — nothing renders until a caregiver is named
├── src/identity/, src/api/, src/sync/  # session/device-id storage, the household+sync HTTP client, SyncProvider
├── src/features/today/, medicines/, schedules/, prnDoses/, inventory/, export/, household/, logs/, settings/
│                                      # Sprint A2's screens — one folder per web feature, same names
├── src/ui/primitives.tsx             # shared RN styling (Card/Badge/Button/colors), the Tailwind-classes equivalent
├── src/testUtils/                    # renderWithRepository + expo-sqlite/secure-store/crypto Jest doubles,
│                                      #   plus Sprint A3's seedAlarmData.ts (schedules/snoozes/sync metadata)
├── jest.config.js                    # Jest + jest-expo, for *.test.tsx (RN component tests) only
└── App.tsx, index.ts
```

`@medguard/shared` is consumed straight from TypeScript source, exactly as `apps/web` and
`apps/api` already do — no build step, no fork of the domain logic. `packages/shared/src/timezone.ts`,
`safety.ts`, `schedule.ts` and `inventory.ts` are untouched by this workspace.

## The A0 exit gate

Open the app and go to the **Settings** tab (Sprint A0's `SpikeScreen` content moved here in
A2 — see "Sprint A2 — feature parity" above for why the rest of Settings isn't a port of web's
push-testing screen):

1. **AD1 — Hermes ICU.** The screen resolves `Asia/Jerusalem 2026-01-15 08:00` through
   `@medguard/shared`'s real `resolveLocal()` on-device and checks it against the known-correct
   UTC instant. If this is ever wrong on a real device, the fix is enabling the ICU-enabled Hermes
   variant or shipping a tzdata shim — **never** reimplementing `timezone.ts` (AD1).
2. **"Play test chime now"** — fires the real `DoseAlarmService` immediately: posts a
   notification, plays the configured weekday length of looping audio on the alarm stream,
   auto-stops.
3. **"Arm alarm in 15s"** — the actual mechanism a dose alarm uses: a real
   `AlarmManager.setAlarmClock()` call 15 seconds out. Lock the phone immediately after tapping.
   The exit gate is this firing — at alarm volume, phone locked, screen off, zero touches — and
   auto-stopping on its own.

## Testing the exit gate on a real device

Three ways to get an installable build onto a phone. None of them requires an Android
SDK/Android Studio *and* a machine at hand simultaneously — pick whichever you have.

### Option A — EAS Build (no Android SDK needed on your machine at all)

Builds remotely on Expo's servers and hands back a QR code / download link for a managed-signed
APK once the one-time credential bootstrap below has been done — useful from a laptop with nothing
but Node installed, or when you're away from your usual dev machine. `apps/android/eas.json`'s
`internal` profile is configured for that installable APK (`"buildType": "apk"`,
`"distribution": "internal"`); the `production` profile builds the Play-ready signed AAB.

```bash
git clone <repo> && cd medguard   # main already has A0-A2 and the CI APK workflow
npm install -g eas-cli
npm install             # workspace deps — from the repo root, not apps/android; without this,
                         # eas/expo can't resolve app.config.ts's local plugins and fails with
                         # "Failed to resolve plugin for module ... Do you have node modules installed?"
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

#### One-time bootstrap for EAS-managed signing

This repo now carries the config and CI wiring for an EAS-managed release, but the first
authenticated run still has to happen from a real machine with Expo/Play access — this sandbox
cannot create or upload credentials to Expo's servers.

1. `npm install` from the repo root (not `apps/android`) if you haven't already — `eas`/`expo`
  need the workspace's `node_modules` to resolve `app.config.ts`'s local plugins. Then
  `cd apps/android && eas login`.
2. If Expo says the project is not linked yet, run `eas project:init` and accept the existing
  `owner`/`slug` from `app.config.ts`.
3. Run `eas build --platform android --profile internal` once and let EAS generate/store the
  Android keystore when prompted. After that, the `internal` profile produces a managed-signed APK
  instead of the debug-signed Gradle artifact Option C builds.
4. Run `eas build --platform android --profile production` for a signed AAB, or
  `eas build --platform android --profile production --auto-submit` once Play submission
  credentials have been configured on the Expo side.
5. For CI, add a repository secret `EXPO_TOKEN`. `.github/workflows/android-eas-release.yml` uses
  it to run the same managed-signed build remotely. `GOOGLE_SERVICES_JSON` stays optional and is
  handled the same way as in `.github/workflows/android-apk.yml`, with one EAS-specific extra:
  `apps/android/.easignore` deliberately re-includes the generated `google-services.json`, because
  remote EAS builds upload a filtered project archive rather than reading the runner's filesystem
  directly.

Convenience commands now exist in this workspace too:

```bash
npm run eas:build:internal --workspace=@medguard/android
npm run eas:build:production --workspace=@medguard/android
npm run eas:submit:production --workspace=@medguard/android
npm run eas:release:production --workspace=@medguard/android
```

#### One-time bootstrap for Play Store submission (`auto_submit`/`eas submit`)

`eas.json`'s `submit.production` is wired to a service account key file
(`play-store-service-account.json`, gitignored, re-included via `.easignore` the same way as
`google-services.json`). None of this can be created from this sandbox — it needs a Google Play
Console account with the app already registered:

1. In [Google Play Console](https://play.google.com/console), create the app listing for
  `il.co.fainsilber.med` (App content, store listing, etc.) and **upload one release manually**
  (Internal testing track is enough). The Play Developer API used by `eas submit` cannot create an
  app's *first* release — there has to be at least one existing release/version code before
  automated submission works.
2. In [Google Cloud Console](https://console.cloud.google.com/) for the same project, enable the
  **Google Play Android Developer API** and create a service account (IAM & Admin → Service
  Accounts), then generate a JSON key for it.
3. Back in Play Console → **Setup → API access**, link that Cloud project if not already linked,
  and grant the service account access to this app with at least the "Release to production, exclude
  devices, and use Play App Signing" / release-management permission.
4. Add the entire JSON key file contents as a repository secret named
  `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
5. Run the `Android Release (EAS)` workflow with `profile: production` and `auto_submit: true`, or
  run `npm run eas:submit:production --workspace=@medguard/android` locally once you have a build to
  submit.

`eas.json` currently targets the `internal` Play track by default — bump `submit.production.android.track`
to `production` once you're ready for a public release.

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

1. On the Settings tab, check **AD1 — Hermes ICU**: "Matches expected fixture" should say `yes`. If
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
   Settings tab hardcodes a 15-second delay, so to test this meaningfully, temporarily change
   `15_000` to something like `5 * 60_000` in
   `src/features/settings/SettingsScreen.tsx`'s `onScheduleLockedPhoneAlarm`, reload the app
   (`r` in the Metro terminal), arm it, then reboot the phone before it fires. Confirm the chime
   still fires on schedule after the reboot completes — this is the "household reboots the phone
   and silently stops getting alarms" failure the plan calls "the worst failure this app can have."
8. **Notification-action capture (Sprint A3):** tap "Taken" or "Snooze" on the notification while
   the chime is playing (or after), then force-stop the app from Android's app-info screen and
   relaunch it. `AlarmEngine.applyPendingActions()` runs on launch, so this should now produce a
   real result rather than only a SharedPreferences entry: a "Taken" tap should show up as a
   logged dose on the Today screen with the **tap** instant as its time (not the relaunch instant
   — check it against the wall clock when you actually tapped), and a "Snooze" tap should show the
   occurrence deferred and a `DoseSnooze` row synced to the second device. If the app is relaunched
   quickly enough that `MedGuardAlarmsModule`'s JS runtime was still alive when the tap landed, the
   `onPendingAction` event should apply it within seconds, before any relaunch is even needed —
   worth confirming both timings. To inspect the durable capture directly before it's applied:
   `adb logcat | grep medguard_pending_actions` or
  `adb shell run-as il.co.fainsilber.med cat /data/data/il.co.fainsilber.med/shared_prefs/medguard_pending_actions.xml`
   — it should go empty once `ackPendingActions` runs.

Useful commands while testing:

```bash
adb logcat | grep -i medguard          # this app's log lines
adb shell dumpsys alarm | grep -A5 il.co.fainsilber.med   # confirm the alarm is actually scheduled
adb shell dumpsys deviceidle whitelist | grep medguard # confirm battery-optimization exemption
```

### Option C — GitHub Actions (no Expo account, no local Android SDK needed)

Builds on a GitHub-hosted runner via a plain `expo prebuild` + Gradle build (`.github/workflows/android-apk.yml`,
`workflow_dispatch` only) — no Expo/EAS account, no secrets, nothing installed locally beyond a
browser. Good default when you just want an APK to sideload and don't need EAS's remote build farm
or OTA updates, and the only option that works from inside a Claude Code sandbox session (Option A
is blocked there — see above). If you want a managed-signed release build instead of the
debug-signed Gradle artifact this workflow produces, use `.github/workflows/android-eas-release.yml`
from a repo with `EXPO_TOKEN` configured.

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
share-sheet export (`SettingsScreen`'s "Share log", now named `medguard-app-log-<timestamp>.txt`
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
  `SyncProvider` and `SettingsScreen` both watch `syncOutbox` — the exact table `drainOutbox()`
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

### Alerts that rang all Shabbat (real-device finding, 2026-08-15)

The worst failure this layer has had, reported from a household: on Shabbat the dose alerts rang
**continuously, all day**, instead of sounding briefly and stopping. The same thing had happened
before without being pinned down.

**Root cause: `DoseAlarmService` could not handle two alarms at once, and that is the ordinary
case.** Several medicines are given at 08:00, so two `AlarmReceiver`s fire and both call
`startForegroundService` on the *same* service instance — `onStartCommand` runs twice. The service
kept its state in three bare fields (`mediaPlayer`, `stopRunnable`, `currentPayload`), and the
second call reassigned `mediaPlayer` over a player that was still `isLooping = true` on
`USAGE_ALARM`. Nothing held a reference to the first one any more; `stopChimeAndSelf()` and
`onDestroy()` both only ever touched the current field, so **nothing in the app could stop it**. It
played until the process died, and every further collision through the day added another orphan.
Two smaller faults rode along: the first alarm's stop callback stayed queued and cut a
later-starting chime short, and `NotificationActionReceiver`'s unconditional `stopService` silenced
a chime belonging to a *different* dose.

On Shabbat there was no way out of it — the Shabbat channel deliberately carries no action buttons
(D5), and force-stopping the app is not something to do on Shabbat.

**Why it got this far.** Nothing in this repo could execute a `Service`, so the corrupted state
lived somewhere no test could reach. That is now fixed structurally as well as behaviourally: the
decision layer is `ChimeSession`, a plain Kotlin class with no Android imports, covered by
`ChimeSessionTest` — this module's first automated tests — which
`.github/workflows/android-apk.yml` runs after prebuild and before `assembleRelease`.

**Fixed** (delta AD10 in `docs/android-client-plan.md`):

- **One sound, several notifications.** However many doses are due at the same minute, one shared
  `MediaPlayer` serves all of them and each keeps its own notification. The player is created only
  on the idle→active transition and never reassigned while non-null, so an orphan is no longer
  expressible. The sound runs to the *latest* deadline, so a dose that starts ringing partway
  through another gets its own full length instead of being cut off.
- **Two lengths.** 60 seconds on a weekday, 30 on Shabbat — the weekday alert can be acted on, so
  its timeout is a backstop; the Shabbat one can only be heard. Both are on `ShabbatConfig`, and
  both are clamped to `[5, 180]` in `chimeDurationSecondsFor()` *and* again in Kotlin immediately
  before playback, so no stored, synced or corrupted value can express an endless ring.
- **Three ways to stop, not one.** Marking the dose now actually silences the phone — a new
  `stopChime` native call, because `cancelDoseAlarm` only unschedules a *future* `AlarmManager`
  alarm and did nothing audible. A physical button counts too: screen-off and unlock immediately,
  screen-on only outside a 3-second grace window (a high-importance notification can light the
  screen itself and would otherwise silence its own alarm), and volume keys through a
  `MediaSessionCompat` remote volume provider. And the timeout, unchanged in principle.

Same caveat as the rest of `modules/medguard-alarms/`: the Kotlin around `ChimeSession` — the
service, the receiver, the media session — is code-reviewed, not run. `ChimeSession` itself is the
first part of this module that is genuinely tested.

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

### Keyboard overlap and build identity (2026-08-09)

Two same-day fixes from continued real-device use, unrelated to each other:

- **On-screen keyboard covering text fields.** No screen used `KeyboardAvoidingView`, so focusing a
  `TextInput` let the keyboard simply overlap it — and the Save/Continue button below it — instead
  of the layout resizing around it. Fixed with a shared `KeyboardAvoidingScreen` wrapper
  (`behavior="height"`, the variant that works on this Android-only app) applied to every screen
  that renders a `TextInput`, directly or via a nested card/form: `MedicineForm`, `ScheduleForm`,
  `HouseholdOnboarding`, `HouseholdScreen`, `CaregiverGate`, `PrnScreen` (`PrnCard`'s override
  reason), `InventoryScreen` (`InventoryCard`'s setup/adjust forms), `ExportScreen`
  (`BackupRestoreCard`'s confirmation field), and `TodayView` (`TakenTimePrompt`/`DoseCorrection`).
  Also adds `keyboardShouldPersistTaps` so buttons stay tappable while the keyboard is up.
- **Build identity.** Per this repo's `CLAUDE.md` convention — every deployable app must expose
  which build is running, from inside the app itself — `app.config.ts` now bakes the git SHA and
  build timestamp into Expo's `extra` at `expo prebuild` time (works for the plain-Gradle CI build
  in `.github/workflows/android-apk.yml`, which has no EAS remote-version tracking). `src/version.ts`
  reads both via `expo-constants`, plus the real installed `nativeBuildVersion` via
  `expo-application`, and all three now show on a "Build" card in Settings — mirrors
  `apps/web/src/version.ts`/`ProbePage.tsx`'s pattern. Neither has been watched on a real device from
  this sandbox; typecheck, lint and the existing Jest suite (updated for the new Settings card)
  are green.

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

A0 through A3 are code-complete (see their sections above); everything below is genuinely still
ahead, per the plan's sprint breakdown:

- **A4** — server Sprint 5: the FCM sender, `dispatch.ts`, the DO dose-alarm chain, escalation
  logic (`DoseSnooze` the *entity* shipped in A3; the DO's `dose_alarms` state machine that reads
  it did not), missed-dose sweep, low-stock push, probe-route removal, and the
  `HeadlessJsTaskService` A3 deliberately deferred (see "Sprint A3" above). None of this exists on
  the API side yet beyond the A3-shipped `dose_snoozes` table, so a scheduled alarm currently has
  no server backstop.
- **A5** — Shabbat on native.
- **A6** — Play Console restricted-permission review, EAS CI wiring, accessibility pass.

## Known gaps in this scaffold, called out rather than hidden

- Chime audio uses the device's default alarm ringtone (`RingtoneManager.TYPE_ALARM`) rather than
  a custom-designed MedGuard tone. The plan's channel table calls for a "custom 45s chime" on the
  Shabbat channel specifically — that's a real audio asset someone needs to supply and drop into
  `modules/medguard-alarms/android/src/main/res/raw/`, then wire into `DoseAlarmService`.
- No app-icon-sized splash asset — `app.config.ts` sets a real `icon`/`adaptiveIcon` (the Star of
  Life mark, matching `apps/web/public/icons`) but no `splash`, so Expo uses its placeholder splash
  screen until one exists.

Two gaps that used to be listed here — no runtime `POST_NOTIFICATIONS` prompt, no in-app DND-bypass
control — are closed: `MedGuardAlarmsModule` now exposes `hasNotificationPermission()` /
`requestNotificationPermission()` (the real `ActivityCompat`-backed prompt via `expo-modules-core`'s
`Permissions` interface, the same mechanism every Expo permission module uses), and the Settings
screen surfaces both that and the pre-existing `hasNotificationPolicyAccess()` /
`requestNotificationPolicyAccess()` as buttons alongside exact-alarms and battery exemption. Neither
has been exercised on a real device yet (see "What hasn't been verified"), so treat them as
code-reviewed, not device-confirmed, until the next on-device pass.

**New in Sprint A3:**

- **A tap made with the app process fully dead isn't applied until the next app open.** See "Drain
  triggers — the deliberate gap" in the Sprint A3 section above. The capture itself is durable and
  the tap timestamp is exact regardless of when it's applied; the gap is latency, not correctness,
  and closes in A4 alongside the headless bootstrap FCM needs anyway.
- **AD6 vs. PRD §4 disagree on the escalation timing A3 doesn't otherwise touch.** AD6's signed-off
  timeline puts the first escalation at 60 minutes; PRD §4, `HouseholdSettings.escalationAfterMinutes`'s
  default, and A4's own exit gate in `docs/android-client-plan.md` all say 15. A3 has no escalation
  logic so nothing here is blocked by it, but A4 cannot start building the DO alarm chain without
  resolving which one is right.

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
