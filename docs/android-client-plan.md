# MedGuard Android Client — Plan

**Version:** 1.0
**Basis:** `medguard-prd.md` v2.0, `medguard-sprint-plan.md` v2.0
**Status:** signed off, in progress (updated 2026-08-08). A0's full locked-phone exit-gate checklist
("Arm alarm in 15s", screen off, zero touches, auto-stop) fired correctly on a real device
2026-08-08, closing out the one thing A0 was still waiting on — see
`apps/android/README.md`'s "Locked-phone alarm, real-device findings" for the two smaller bugs that
same test found and fixed (a notification-lifecycle bug; a PRN clock-trust false-positive after any
real device sleep, fixed with an explicit go-ahead since it touches safety-critical dose gating —
new native `elapsedRealtimeMs`/`SystemClock.elapsedRealtime()` export replacing the
sleep-sensitive `performance.now()` reference). The same session's device-revoke test found local
data stays on a revoked device indefinitely (server-side only deletes the device row) — see
`apps/android/README.md`'s "Revoked-device data retention" for the fix: a distinct `'revoked'` sync
status plus a manual, two-step "Clear local data" confirm, not an automatic wipe. A1
(`packages/store` extraction, the SQLite `Store`, the
conformance suite) is code-complete against the exit gate below, including the derivation-helper
move (finished in A2, once a real Android caller existed). **A2 (feature parity) is code-complete**:
every screen exists, wired into a real `@react-navigation` shell against a real repository/SQLite
store, with a Jest + `@testing-library/react-native` suite covering the safety-critical flows — see
`apps/android/README.md`'s "Sprint A2 — feature parity" for what's verified and what still needs a
real device. The web track is at Sprint 4 complete; Sprint 5 (alarms, push, escalation) is
unstarted and this plan absorbs it as A4. **A6's "installable build without a local Android SDK"
need is partly pulled forward and done**: `.github/workflows/android-apk.yml` (merged 2026-08-07,
`main`) builds a sideloadable APK on a GitHub-hosted runner via plain `expo prebuild` + Gradle — no
Expo/EAS account. The first real-device install (2026-08-07) found the workflow's original
`assembleDebug` build never actually launched (no bundled JS, needs a Metro server), the app had no
launcher icon wired up, `app.config.ts` shipped a dead placeholder API host that broke every
network call, and the bottom tab bar had no icons wired up at all (React Navigation's own
placeholder glyph on every tab) — all fixed same day (`assembleRelease`, `app.config.ts` icon
entries, `apiBaseUrl` fallback removed in favor of `src/api/config.ts`'s real one, `tabBarIcon` per
tab; see `apps/android/README.md` "Option C"). A follow-up install of that fixed build, same day,
joined a household successfully but found sync itself broken on-device — `expo-sqlite`'s single
native connection has no built-in queue, so the sync engine's own writes and `useLiveQuery`'s
fire-and-forget refetches could race for it and throw "cannot start a transaction within a
transaction"; both concurrency sources are now fixed at the `SyncEngine`/`ExpoSqliteDriver` level
(see `apps/android/README.md`'s "Sync and household join"), still needing a fresh on-device confirm
of its own. This is still the fast, no-secrets Gradle validation path, not the Play release path —
the EAS-managed build/submit half of A6 is now repo-configured (`apps/android/eas.json`,
`.github/workflows/android-eas-release.yml`, and the Android workspace EAS scripts) but cannot be
exercised from this sandbox because Expo/Play authentication and credential upload happen outside
it. **2026-08-09:** two more same-day fixes from continued real-device use —
no screen used `KeyboardAvoidingView`, so the on-screen keyboard could overlap a focused text field
and the button below it instead of the layout resizing around it (fixed with a shared
`KeyboardAvoidingScreen` wrapper applied to every form/text-input screen); and the app had no way to
tell which build a device was running, closed per this repo's standing "every app exposes its build
identity" convention (see root `CLAUDE.md`) — `app.config.ts` now bakes the git SHA and build
timestamp into Expo's `extra`, read via `expo-constants` alongside the real installed
`nativeBuildVersion` from `expo-application`, both shown on a "Build" card in Diagnostics.
**A4 (Server Sprint 5) is code-complete as of 2026-08-09, not yet device-confirmed** — the FCM
sender, the provider-blind fan-out, the DO dose-alarm chain with escalation at the household's own
`escalationAfterMinutes`, the AD6 missed-dose sweep, low-stock push, AD8's probe removal, both
clients' receive paths, and the `HeadlessJsTaskService` A3 deferred. The `runDurableObjectAlarm`
half of its exit gate passes; the two-real-phone half needs hardware and a Firebase project. See
A4's section below.
**A3 (the local alarm engine) is code-complete, not yet device-confirmed** — see the A3 section
below and `apps/android/README.md`'s "Sprint A3" for the full account. `DoseSnooze` shipped as a
full synced entity ahead of A4 (delta AD5); the `HeadlessJsTaskService` this plan originally
specified was deliberately deferred to A4, where it's built once and shared with the FCM handler
A4 needs anyway — see A3's section for what covers the gap that leaves. One inconsistency the A3
work surfaced but didn't need to resolve: AD6's signed-off missed-dose timeline puts the first
escalation at 60 minutes, while PRD §4, `HouseholdSettings.escalationAfterMinutes`'s default, and
A4's own exit gate below all say 15 — **settled at the start of A4 in favour of 15**, see AD6.
**Team model:** Claude builds; you guide, decide, review.

---

## Context

The sprint plan has named a native Android client since v1.0, but only as a label. Two places say
*why* it should exist and nothing says *how*:

- **Decisions, `medguard-sprint-plan.md` line 24** — "No dedicated device. Web Push for locked
  phones; in-app 45s chime engine when foregrounded. **Native Android app (Phase 2) solves the
  locked-device case properly.**"
- **Delta D1** — the PRD's 45-second auto-stopping Shabbat chime *cannot* be delivered by a browser.
  Web Workers are suspended when backgrounded, Service Workers cannot play audio at all, and Sprint
  0 confirmed on-device that a Web Push notification's `sound` field is never retained. The web app
  ships a 10-push burst as an approximation, tuned four times against a real phone.

Delta D8 already paid the cheap preparation cost: `devices.push_provider` is `'webpush' | 'fcm'`
with a `push_credentials` JSON column (`apps/api/migrations/0002_domain.sql:49-51`), routes are
versioned under `/api/v1/`, and the whole domain lives in `packages/shared` as pure TypeScript that
"compile[s] in the browser, in workerd, and in a future native client"
(`packages/shared/src/types.ts:7`). A native client registers against the existing backend with no
migration.

This document is the missing half. It plans an Android client that reaches full feature parity with
the PWA, implements the PRD §4 alarm matrix properly rather than approximately, uses the whole
existing `/api/v1/` surface, and stays fully usable offline the way the PWA is.

Three decisions shape everything below and are settled, not open:

1. **React Native + Expo**, chosen so `packages/shared` is consumed verbatim. Cross-cutting rule 5
   says safety logic is shared, never duplicated. A Kotlin rewrite of `safety.ts`, `schedule.ts`,
   `timezone.ts` and `inventory.ts` would put the Android app outside the 100%-branch coverage gate
   the entire project is built around — the gate would still pass, and would no longer mean
   anything for the client most people actually use.
2. **This plan owns the missing server work.** Sprint 5 is unbuilt and no FCM sender exists at all.
   Android drives Sprint 5 rather than waiting behind it.
3. **Shabbat is in scope.** The locked-device chime is the entire reason the native client exists;
   deferring it would defer the point.

---

## What the native client buys

Everything else in this document is cost. This is the return.

| Capability | PWA today | Native Android |
| --- | --- | --- |
| Auto-stopping chime on a locked phone, no touch | **Impossible** (D1) — approximated by 10 pushes ~1.11s apart | Real: alarm-stream audio for a configurable duration, `stopSelf()` at the end |
| Alarm when the device has no network | **No** — depends on server push | Yes: `AlarmManager` fires from local data |
| Alarm precision when backgrounded | Server-scheduled only; in-page timers showed a **54.5s** gap against a 5s interval | Exact, Doze-exempt |
| Custom notification sound | **Never retained** — measured, `retainedOptions: ["tag","renotify","requireInteraction"]` | Per-channel custom sound |
| Sound through ring-silent | No | Yes — `AudioAttributes.USAGE_ALARM` |
| Bypass Do Not Disturb | No | Yes, with a user-granted notification-policy exemption |
| Full-screen escalation | No | Yes, subject to Android 14+ policy (see AD4) |
| Survives reboot | N/A (nothing local scheduled) | Yes, via re-arm receivers |

The PWA is not replaced. It stays the iOS story, the desktop story, and the zero-install story;
`push_provider` exists precisely so both clients coexist in one household.

---

## Deltas from the PRD and the sprint plan

Places where the existing documents are wrong, unachievable on Android, or silent. Numbered `AD`
so they never collide with the sprint plan's `D1`–`D8`. **Most worth your review attention.**

**AD1 — Hermes has no guaranteed full ICU.** `packages/shared/src/timezone.ts` depends on
`Intl.DateTimeFormat` with arbitrary IANA zones and `formatToParts`, and every wall-clock dose time
in the system resolves through it. A React Native engine built without full ICU would silently
resolve every zone to UTC — meaning every dose time is wrong, in the most dangerous possible way:
plausibly, consistently, and without an error. **Fix:** verify this in Sprint A0 before a single
screen is built, with an assertion test that resolves a known DST boundary in `Asia/Jerusalem` and
compares against the fixtures `timezone.test.ts` already uses. If ICU is absent, enable the
ICU-enabled engine variant or ship a tzdata shim — never reimplement `timezone.ts`.

**AD2 — Kotlin must not write intake logs.** A notification action tapped while the app process is
dead still has to produce a dose record, and the obvious shortcut is to insert it from Kotlin.
That would be a second implementation of the append-only ledger — the transaction in
`apps/web/src/db/repository.ts` writes a log, an inventory adjustment and two outbox rows
atomically, and a Kotlin copy would drift from it. **Fix:** Kotlin records *intent* only (see
"Acting on a notification when the app is dead"); JavaScript converts intent into domain state
through the one tested repository.

**AD3 — The Shabbat push burst is web-only.** `SHABBAT_BURST_COUNT = 10` /
`SHABBAT_BURST_SPACING_MS = 1111` exist because a single push yields a ~1–2 second system tone,
nowhere near the PRD's 45 seconds. On native the local alarm plays the real 45 seconds, so the
burst is not merely unnecessary — it would be ten redundant notifications. **Fix:** the burst stays
for `push_provider: 'webpush'` devices; an `fcm` device receives a single informational message.
The OS notification-coalescing limit that took four tuning rounds to work around
(`docs/platform-capabilities.md`, "Burst density") stops applying on Android entirely.

**AD10 — The chime is one sound for however many doses, with two lengths and three ways to stop.**
Added after a Shabbat on which the alerts rang continuously all day. `DoseAlarmService` kept its
state in three bare fields — one `MediaPlayer`, one stop `Runnable`, one payload — which is correct
only if alarms never overlap. They do: a household gives several medicines at 08:00, so two
`AlarmReceiver`s start the *same* service instance and `onStartCommand` runs twice. The second call
reassigned `mediaPlayer` over a player that was still looping on `USAGE_ALARM` and that nothing held
a reference to, so nothing could ever stop it; it rang until the process died, and each further
collision through the day added another. On Shabbat the notification carries no buttons (D5) and
force-stopping the app is not an option, so there was no way out of it at all.

**Fix, in three parts.** *(1)* The state moves into `ChimeSession`, a plain Kotlin class with no
Android imports and the module's first JVM unit tests (`ChimeSessionTest`, run by
`.github/workflows/android-apk.yml`) — the bug got through precisely because nothing in this repo
could execute a `Service`. One shared player serves every sounding dose, each keeps its own
notification, and the sound runs to the *latest* deadline so a dose that starts ringing partway
through another is not cut short. *(2)* Two lengths rather than one: 60s on a weekday, 30s on
Shabbat, both on `ShabbatConfig` and both clamped to `[5, 180]` in `chimeDurationSecondsFor()` and
again in Kotlin, so no configured or synced value can express an endless ring. *(3)* Three stop
conditions instead of one. The dose being marked now actually silences the phone — `cancelDoseAlarm`
only unschedules a *future* alarm, so tapping Taken on a ringing phone used to change nothing
audible. A physical button counts too: screen-off and unlock unambiguously, screen-on only outside a
3-second grace window, because a high-importance notification can light the screen itself and would
otherwise silence its own alarm. Volume keys arrive through a `MediaSessionCompat` with a remote
volume provider, the only way an app sees them while the sound is on the alarm stream.

**AD4 — `USE_EXACT_ALARM` and `USE_FULL_SCREEN_INTENT` are Play-reviewed, not merely declared.**
Both are restricted permissions requiring a Play Console declaration and a demo video. Medication
reminders are an eligible category for exact alarms, but eligibility is decided by a human
reviewer, not by the manifest. Full-screen intent is auto-granted on Android 14+ only to apps whose
core function is calling or alarms, and the Play Store revokes it at install for apps that don't
qualify. **Fix:** check `NotificationManager.canUseFullScreenIntent()` at runtime and degrade to a
heads-up notification, routing the user to `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`; reserve
full-screen intent for escalation only. A full-screen takeover on every ordinary dose would be
hostile — on an escalation, where a dose has already gone unacknowledged for 15 minutes, it is the
entire point.

**AD5 — Snooze has no persisted representation.** `TodayView.tsx:161-167` keeps `snoozedUntil` in a
component `Map`, so a reload clears it. `HouseholdSettings.snoozeMinutes` is stored and never read.
That means snooze cannot survive a reload, cannot be bounded (Sprint 5 requires a "bounded snooze
count"), and — most importantly — cannot stop an escalation, because the server never learns it
happened. **Fix:** a new append-only synced entity `DoseSnooze`. Append-only rather than LWW so two
caregivers snoozing the same dose concurrently don't clobber each other, and so the bound is simply
the count of records.

**AD6 — "Missed" is undefined.** `IntakeStatus` includes `'missed'` and Sprint 5 lists "missed-dose
detection" as scope, but neither the PRD nor the sprint plan says when a dose becomes missed.
**Signed off:** an occurrence becomes `missed` when `now > scheduledTime + 180 minutes` (3 hours)
and no effective log exists. Written by the server as a real `IntakeLog{status:'missed'}`, so it is
an append-only fact a caregiver can correct (invariant 1), never a status the UI derives and
re-derives differently. Suppressed entirely in Shabbat mode, which writes `pending_shabbat`
instead.

*Timeline corrected in A4 (2026-08-09).* This paragraph originally put the first escalation at 60
minutes, which contradicted PRD §4, `HouseholdSettings.escalationAfterMinutes`'s default, and A4's
own exit gate — all three of which say 15. **Resolved in favour of 15**: it was the value in three
of the four places, and the one already stored on every existing household. Nothing about the hour
is lost — three snoozes at `DEFAULT_SNOOZE_MINUTES` (20) still cover exactly 60 minutes of
deferral, which is what that number was protecting. The implemented timeline:

| Elapsed since `scheduledTime` | Behaviour |
| --- | --- |
| 0 → `escalationAfterMinutes` (default 15) | Silent. The local alarm and the initial `dose` push only. |
| at the boundary, unacknowledged | `escalation` push to every registered device in the household. |
| any point, snoozed | Deferred by `snoozeMinutes` from the *tap*; escalation re-arms at the deferral deadline. Bounded at `MAX_SNOOZE_COUNT` (3), now enforced on the server as well as in the UI. |
| 180 minutes | `IntakeLog{status:'missed'}`, written by the Durable Object. |

**AD7 — Doze, OEM battery managers and Do Not Disturb cannot be fully solved in software.**
`setAlarmClock` plus a battery-optimization exemption plus a user-granted notification-policy
exemption gets most of the way. Xiaomi, Huawei and Oppo autostart managers cannot be granted
programmatically at all. **Fix:** a guided setup checklist (which Sprint 6 already owed as a "Do Not
Disturb / Focus setup checklist"), and an honest in-app "alarms may not fire" state whenever
`canScheduleExactAlarms()` is false or notifications are disabled — safety invariant 6, visible
degradation.

**AD8 — The unauthenticated probe push relay must go before a native client ships.**
`POST /api/v1/probe/push` (`apps/api/src/routes/probe.ts:39`) takes a caller-supplied subscription
endpoint and sends VAPID-signed pushes to it, with no auth. It is an open relay and it also
instantiates arbitrary Durable Objects by `probeId`. The code already marks it for Sprint 5
removal; shipping a second client alongside it is not acceptable. **Fix:** delete the probe routes,
replace with an authenticated `POST /api/v1/devices/push` for push-credential registration.
**Done in A4** — `probe.ts`, its two Durable Object methods and its two DO tables are gone;
registration lives on `deviceRoutes` behind `requireDevice`, and writes only the calling device's
own row. The web probe page survives as a Diagnostics screen, because it carries the build-identity
line this repo's conventions require.

**AD9 — Native app replaces PWA on Android.** Both clients register against the same backend with
`devices.push_provider: 'fcm' | 'webpush'`, but a household running both on the same device creates
two local alarm sources for the same occurrences. While `occurrenceKey` dedupe prevents stacking
notifications, the operational model is simpler if caregivers migrate to native once available.
**Signed off:** Android households migrate to native app; PWA remains the sole client on iOS and
web. Deployment is staged: internal test → Play rollout → migration UI guides uninstall → backwards
compatibility handled via server-side deduplication.

---

## Architecture

### Framework and workspace

`apps/android/` becomes a fourth npm workspace. Expo with continuous native generation — no
committed `android/` directory — plus a local config plugin at
`apps/android/plugins/withMedGuardAlarms.ts` that owns every manifest entry the alarm layer needs.
Permissions and service declarations then live in one reviewable TypeScript file rather than being
hand-edited into generated output where the next `prebuild` silently discards them.

```
apps/android/
├── app.config.ts · metro.config.js · eas.json
├── plugins/withMedGuardAlarms.ts        # every manifest entry, in one place
├── modules/medguard-alarms/             # local Expo module (Kotlin + TS surface)
│   ├── src/                             # TS interface
│   └── android/src/main/java/…/         # AlarmScheduler, receivers, service, channels
└── src/
    ├── runtime/                         # the ONLY ambient-time/ID edge
    ├── store/                           # SQLite Store implementation
    ├── alarms/                          # horizon materialization, arming, dedupe
    └── features/                        # screens, mirroring apps/web/src/features/
```

**Metro in a monorepo** is the known friction point. `apps/android/metro.config.js` needs
`watchFolders` rooted at the repository, `nodeModulesPaths` covering both the local and hoisted
`node_modules`, and `unstable_enablePackageExports` so `@medguard/shared`'s `exports` map (`.` and
`./testing`) resolves. Note that `@medguard/shared` sets `"main": "./src/index.ts"` — raw
TypeScript, exactly as Vite and workerd already consume it — so Metro transpiles it from source with
no build step, which is what keeps it a genuinely shared module rather than a published artifact.

**Cross-cutting rules extend unchanged.** The no-ambient-time ESLint rule
(`eslint.config.js:61-72`) gains `apps/android/src/**`, with `apps/android/src/runtime/**` as the
only exempt edge, mirroring `packages/shared/src/runtime/`.

**Two data-handling requirements that are easy to miss and expensive to get wrong:**

- `android:allowBackup="false"` with explicit `dataExtractionRules`. Android's auto-backup would
  otherwise copy the SQLite database — a child's complete dosing history — into the user's Google
  Drive, silently and by default. `docs/data-handling.md` needs a corresponding entry.
- The device token goes in `expo-secure-store` (Android Keystore), not the web client's
  localStorage equivalent. A modest improvement over the PWA, and free here.

### Storage and the sync port

**`expo-sqlite`**, for its async API and clean CNG integration. It turned out to have no
change-notification API of its own — unlike this section originally assumed, nothing analogous to
Dexie's `useLiveQuery` reactivity ships with it — so A2 built `NotifyingStore`
(`packages/store/src/notifyingStore.ts`) on top to supply that, and `src/store/useLiveQuery.ts` is
its RN-side hook (see `apps/android/README.md`'s "Sprint A2 — feature parity"). It also turned out
to open exactly one native connection with no queue of its own: two independent callers'
transactions (the sync engine and a live-query refetch, say) can race for it and one gets rejected
outright rather than waiting its turn — a real bug a caregiver's device hit 2026-08-07, fixed by
adding that queue in `ExpoSqliteDriver` (`apps/android/README.md`'s "Sync and household join").
`op-sqlite` is the escape hatch if throughput bites at 12 months of logs.

The harder question is the sync engine. `apps/web/src/sync/engine.ts` is already a framework-free
class, but it is Dexie-typed, and it carries safety invariant 7 — no log lost across an
offline→online cycle, no retry ever double-applying. Copying it into the Android app would create
exactly the duplication rule 5 forbids, in the one place where a bug loses a dose record.

**New workspace `packages/store/`** — a storage-agnostic repository and sync engine behind a narrow
`Store` interface (`transaction`, `get`, `put`, `append`, `queryByIndex`). Extracted from
`apps/web/src/db/repository.ts`, `apps/web/src/sync/engine.ts`, `apps/web/src/sync/cursor.ts` and
`apps/web/src/sync/tableDispatch.ts`. The web app supplies a Dexie-backed `Store`; Android supplies
a SQLite-backed one. `packages/store`'s merge and outbox code joins the 100%-branch coverage list in
`vitest.config.ts`.

This is the riskiest non-Android change in the plan, because it touches a working, deployed app that
currently passes 700 tests. It is behavior-preserving by construction: **one conformance suite runs
against both `Store` implementations**, so "the port didn't change anything" is a test result rather
than a claim, and the existing web suite is the regression net underneath it.

Two smaller lifts go with it. The pure derivation helpers currently stranded in the web app —
`features/today/classifyOccurrence.ts`, `features/today/matchOccurrenceLog.ts`,
`features/prnDoses/formatCountdown.ts`, `features/schedules/scheduleDisplay.ts` — move into
`packages/shared`, so both clients agree on what "overdue" means and on the undocumented 5-minute
`DUE_NOW_WINDOW_MS`. And `apps/web/src/sync/liveClient.ts` moves with the engine.

**One deliberate non-optimization:** React Native's WebSocket *can* set headers, unlike a browser,
so Android could authenticate `/api/v1/live` with an ordinary `Authorization` header instead of the
`Sec-WebSocket-Protocol` workaround. It won't. Using it would fork the server's auth path for one
client, and `HouseholdDO`'s connection handling is not where we want two shapes. Recorded here so
nobody "fixes" it later.

---

## The native alarm layer

The heart of it, and the only part that has to be Kotlin. Everything above this line is JavaScript
running the same domain code as the web app.

`apps/android/modules/medguard-alarms/android/src/main/java/…/` — `AlarmScheduler.kt`,
`AlarmReceiver.kt`, `BootReceiver.kt`, `DoseAlarmService.kt`, `MedGuardChannels.kt`, plus a thin TS
surface the JS alarm engine calls.

### Scheduling

**`AlarmManager.setAlarmClock()` for dose alarms**, not `setExactAndAllowWhileIdle`. It is the
highest-priority alarm class Android offers: exempt from Doze and from App Standby buckets, never
batched with other apps' alarms, and — the practical difference — respected far more consistently by
OEM battery managers. The cost is that it surfaces an upcoming-alarm affordance in the system UI,
which for a medication app is arguably a feature. `setExactAndAllowWhileIdle` is right for the
lower-stakes items: the low-stock check and the missed-dose sweep.

**Permissions.** `USE_EXACT_ALARM` (Android 13+) is install-time and needs no user grant, and
medication reminders are an eligible category for it — subject to AD4's Play review.
`SCHEDULE_EXACT_ALARM` is retained for Android 12 with a runtime prompt via
`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`. `AlarmManager.canScheduleExactAlarms()` is checked on every
arm, and a false result is not a silent failure — it drives the "alarms unarmed" state.

**Re-arming.** Alarms do not survive a reboot, and a household that reboots a phone and quietly
stops getting dose alarms is the worst failure this app can have. `BootReceiver` handles
`BOOT_COMPLETED`, `LOCKED_BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`, `TIME_SET` and `TIMEZONE_CHANGED`.

### The chime

`AlarmReceiver` starts `DoseAlarmService` with `foregroundServiceType="mediaPlayback"` —
deliberately *not* `dataSync` or `mediaProcessing`, the two types Android 15 caps at six hours per
24-hour period. Starting a foreground service from the background is permitted here because
delivery of an exact alarm is an explicit exemption to the background-start restrictions.

`MediaPlayer` with `AudioAttributes.USAGE_ALARM` and `CONTENT_TYPE_SONIFICATION` plays on the alarm
stream, which is what makes it sound through ring-silent, then `stopSelf()` at
`chimeDurationSeconds` (PRD default: 45). **No wake lock, no screen wake, no touch** — PRD §3 is
explicit that the screen remains in its current state and no touch interactions are triggered. This
is the thing the web cannot do, done literally.

### Channels

Created once in `MedGuardChannels.kt` with **versioned ids** — `dose_standard_v1`,
`dose_escalation_v1`, `shabbat_v1`, `low_stock_v1`, `sync_status_v1`. A notification channel's sound
and importance are immutable after creation, so without versioned ids, retuning the chime the way
the Shabbat burst was retuned four times would require every caregiver to reinstall the app.

| Channel | Importance | Sound | Actions |
| --- | --- | --- | --- |
| `dose_standard_v1` | HIGH | default | Taken, Snooze |
| `dose_escalation_v1` | HIGH, bypass DND if granted | default | Taken, Snooze; full-screen intent when permitted |
| `shabbat_v1` | HIGH | custom chime, 30s default | **none** (D5) |
| `low_stock_v1` | DEFAULT | default | Open inventory |
| `sync_status_v1` | LOW, ongoing | silent | — (carries the "alarms unarmed" / "sync stale" states) |

**DND bypass** requires `ACCESS_NOTIFICATION_POLICY` and a user grant through
`ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS`. It cannot be forced, which is why AD7 exists and why
Sprint 6's setup checklist becomes a real guided flow rather than a documentation page.

**Battery-optimization exemption** is requested during onboarding via
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, alongside the OEM autostart checklist.

### Acting on a notification when the app process is dead

The crux, and the one place where a wrong answer quietly breaks the append-only ledger.

**Kotlin never writes an intake log.** The action handler writes one row to a `pending_actions`
table in the same SQLite file — *"the user pressed Taken on occurrence X at instant T from device
D"* — which is durable the moment the tap happens, even if nothing else starts successfully. It
then starts a `HeadlessJsTaskService` (foreground, `shortService` type) whose JavaScript task drains
`pending_actions` through the *same* `recordDose()` the UI calls, writing the log, the inventory
adjustment and both outbox rows in one transaction, then kicks a sync drain.

Intent capture is native, instant and durable; converting intent into domain state stays in the one
shared, tested implementation. The alternative — a native-side insert — would be faster to build and
would put a second copy of the ledger rules in a language with no coverage gate over it.

The timestamp recorded is the tap instant, not the drain instant. That matters: `actualTime` starts
the rolling-24h cap window, and the Sprint 2 change that added `TakenTimePrompt` exists precisely
because recording the wrong moment misstates both the history and the safety math.

---

## Local versus server alarms

Both the device and the Durable Object can schedule. Both firing means two notifications for one
dose. The authority model:

**The device's local alarm is primary; the server push is the backstop.** Only the local alarm works
with no signal — and a caregiver in a hospital basement is a real scenario this product already
designs for (Sprint 3: "a caregiver in a hospital with no signal must never be blocked from logging
a dose"). Sprint 0 measured both mechanisms as precise, so there is no accuracy argument for
preferring the server.

- Every notification, local or push, uses `occurrenceKey` (already exported from
  `packages/shared/src/schedule.ts`, already tested) as its Android notification tag. A late push
  therefore *replaces* the local notification rather than stacking a second one.
- The device suppresses an incoming `dose` push for an occurrence it has already notified locally,
  tracked in a local `alarm_state` table.
- **The server does not attempt to suppress.** It cannot know whether a given device's local alarm
  actually fired — the phone may be off, the permission revoked, the OEM battery manager may have
  eaten it. For a medication alarm, one redundant notification is the correct direction to fail
  (invariant 3, fail closed).
- **Escalation is server-only.** A device cannot know whether *another* caregiver acknowledged; that
  is exactly what the Durable Object is for.

**When local data is stale.** The device re-materializes its alarm horizon on every sync pull and
every app foreground. If the last successful sync is older than 24 hours, the Today screen and the
`sync_status_v1` ongoing notification say so — invariant 6, visible degradation. Alarms already
armed keep firing; the app just stops claiming they're authoritative.

**When the device is unarmed** — permission denied, battery-optimized, notifications off, app
uninstalled — nothing local fires. The server push covers the gap, and if it goes unacknowledged the
escalation reaches the other caregivers. This is the case that justifies keeping server-side
scheduling at all rather than going local-only.

---

## Server-side work (Sprint 5, absorbed)

| Piece | Path | Design |
| --- | --- | --- |
| FCM HTTP v1 sender | `apps/api/src/push/fcm.ts` | Service-account JSON as a Worker secret. RS256 JWT signed with WebCrypto (`importKey('pkcs8', …)`, `RSASSA-PKCS1-v1_5`, SHA-256), exchanged at `oauth2.googleapis.com/token`, access token cached ~55 min against its 1-hour life. Classifies `UNREGISTERED` / `INVALID_ARGUMENT` as expired, mirroring how `sendPush` already classifies 404/410. |
| Unified fan-out | `apps/api/src/push/dispatch.ts` | One entry point reads `devices.push_provider` and routes each device to `sendPush` or `sendFcm`, returning a uniform per-device result so expired credentials are pruned identically. Everything above it — escalation, low-stock, Shabbat fan-out — stays provider-blind. |
| Real payload contract | `packages/shared/src/push.ts` | Replaces the probe-only `ProbePushPayload` with a discriminated union: `dose`, `escalation`, `shabbat`, `low_stock`. FCM messages are **data-only** (no `notification` block) with `android.priority: "HIGH"`, so the app composes the notification and controls the channel and actions, and the message still wakes the device from Doze. |
| Dose alarm chain | `apps/api/src/do/HouseholdDO.ts` | DO SQLite table `dose_alarms(occurrence_id PK, medicine_id, schedule_id, due_at_ms, state, escalate_at_ms, snooze_count, fired_at_ms)`, driven by a single chained `setAlarm` — the exact pattern `schedulePushBurst` already proves works (`HouseholdDO.ts:332-424`). The probe queue is deleted alongside it. |
| Occurrence horizon | same | Materialized from `schedules` over a rolling **48 hours**, re-materialized whenever a `schedules` or `household_settings` record lands in `applyBatch` — already the single write path for everything, so it's the natural hook — and whenever the chain runs dry. A schedule edit therefore cancels and reschedules implicitly, with no per-schedule alarm bookkeeping to get wrong. |
| Escalation | same | `pending → notified → acknowledged \| escalated`, state in DO SQLite. Acknowledgement arrives as an ordinary synced `IntakeLog` or `DoseSnooze`, which `applyBatch` already sees — so "stopping immediately on acknowledgement from any device" falls out of the existing write path with no new channel. |
| Snooze as data | `0003_alarms.sql`, `packages/shared/src/types.ts`, `schemas.ts`, `apps/api/src/sync/tables.ts` | `DoseSnooze { id, occurrenceId, minutes, count, createdAt, createdByUserId, createdByDeviceId }`, append-only (AD5). Each snooze grants 20 minutes; `MAX_SNOOZE_COUNT = 3` signed off. |
| Missed-dose sweep | same | Per AD6, and only outside Shabbat mode. |
| Low-stock push | `apps/api/src/do/HouseholdDO.ts` | Evaluated in `applyBatch` after any `inventory_adjustments` write using `deriveInventoryState` from shared. A downward threshold crossing dispatches once per medicine, with a flag cleared on refill so it cannot spam — PRD §2.4's "notifications across all caregiver devices". |
| Probe removal | `apps/api/src/routes/probe.ts` | Deleted (AD8), replaced by an authenticated `POST`/`DELETE /api/v1/devices/push` plus `GET /api/v1/devices/push/vapid-public-key`. Web's probe page becomes `src/diagnostics/DiagnosticsPage.tsx`, keeping the build-identity line and the app log. |

Note the one thing that does *not* need building: authentication, sync, conflict resolution, the
authoritative safety re-check and the live channel all work as-is. The Android client is a second
consumer of a surface that already exists, which is what delta D8 bought.

---

## Shabbat on native

- **The chime becomes literal.** `setAlarmClock` at the occurrence → `AlarmReceiver` →
  `DoseAlarmService` → alarm-stream audio that stops itself, 30 seconds on Shabbat by default. No
  wake lock, no touch, screen state untouched. This is exactly what D1 says a browser cannot do.
- **The push burst is retired on native** (AD3) and kept for web.
- **No action buttons** (D5) — the Shabbat channel has none, and tapping the notification opens a
  passive read-only view. Reconciliation happens after Havdalah.
- **All-device fan-out** stays a server behavior for the push half, per D5 and
  `docs/halachic-decisions.md` Q3: the initial burst reaches every registered device, so there is
  structurally nothing left to escalate to.
- **Zmanim compute server-side**, per Sprint 6, with the computed windows synced down so the device
  can arm local alarms in Shabbat mode with no network. Computing them on-device *as well* would be
  a second implementation of a halachically-sensitive calculation — precisely what rule 5 forbids,
  and in the one area where being wrong by 18 minutes is a real problem. The device caches an
  8-week horizon, matching the verification screen Sprint 6 already plans.
- `pending_shabbat` is written locally by the alarm engine when the household is in mode; the
  Motzei Shabbat reconciliation sheet is an ordinary screen over the same data.

**This sprint cannot ship before the halachic questions come back.** `docs/halachic-decisions.md` is
explicit that its answers are "pragmatic placeholders, not a ruling."

---

## Test strategy

| Layer | Tooling | What it proves |
| --- | --- | --- |
| Domain | Vitest (**unchanged**) | `packages/shared` is untouched by this work; the 100% branch gate still means what it meant. |
| Store | Vitest, `better-sqlite3` + `fake-indexeddb` | One conformance suite run against **both** `Store` implementations — the proof the extraction changed nothing, and that the SQLite store upholds invariant 7. |
| RN UI | Jest + `@testing-library/react-native` | Mirrors the existing RTL specs: GREEN/RED/CAPPED states, the live countdown, the locked→unlocked flip at the exact boundary, two-step override, `TakenTimePrompt`. |
| Kotlin | Robolectric (landed 2026-08-16 — see `docs/testing.md`) | Arming and cancellation against `ShadowAlarmManager`, `PendingActionStore` durability and the read/ack split (invariant 7), boot re-arm, notification-action handling. **Correction**: `AlarmScheduler` does **not** take an injected time source — `BootReceiver.kt` calls `System.currentTimeMillis()` directly, which Robolectric does not shadow, so those tests use far-future/far-past instants rather than a fake clock. No instrumented `androidTest` layer exists or is planned; Robolectric plus Maestro (below) cover what it would have, without needing an emulator inside the Gradle job itself. |
| Worker + DO | `runDurableObjectAlarm` (existing harness) | The dose chain, and escalation firing at exactly the configured boundary. FCM `fetch` mocked at the endpoint boundary with a fixed service-account keypair, the same shape as the existing VAPID units. |
| Device | Maestro + `adb shell am broadcast` (landed 2026-08-16 — see `docs/testing.md`) | The full notification-action path including tapping "Taken" from the lock screen with the app force-stopped. **Correction**: `NotificationActionReceiver` and `DoseAlarmService` are `android:exported="false"` (`plugins/withMedGuardAlarms.ts`), so `am broadcast -n` from the plain shell UID gets a Permission Denial — this needs `adb root` and a rootable `google_apis` system image (not `google_play`, which the *manual* QA drill elsewhere in this doc recommends instead, and deliberately does not use here). `BootReceiver` has no such restriction (`android:exported="true"` with a real intent filter), so its drill needs neither root nor a special image. |

Coverage gates are unchanged and extended: `packages/store`'s merge and outbox code joins the
100%-branch list, because it carries invariant 7.

---

## Sprints

Same cadence as the web track: no fixed dates, a sprint ends when its exit gate passes.

### A0 — Spike and scaffold

**Scope:** Expo app boots inside the monorepo with `@medguard/shared` importing and its tests still
green; the **Hermes ICU spike** (AD1); a minimal Kotlin alarm that fires `setAlarmClock` and plays
45 seconds of alarm-stream audio that stops itself.

**Exit gate:** the 45-second chime fires on a real, *locked* Android phone, at alarm volume, and
auto-stops, with zero touches — and `Asia/Jerusalem` DST boundaries resolve identically to
`timezone.test.ts`'s fixtures under Hermes.

This gate is the premise of the entire native client. It is deliberately first, and nothing else is
built until it passes. Failing it early costs a week; failing it in A5 costs the project.

### A1 — Storage and sync port

**Scope:** `packages/store` extraction; the SQLite `Store`; the conformance suite; the derivation
helpers lifted into `packages/shared`.

**Tests:** the conformance suite against both stores; the full existing web suite unchanged.

**Exit gate:** the offline create-medicine → schedule → log-a-dose → verify-stock-decrement flow
passes on Android with no backend running — the same thing `offline-smoke.spec.ts` proves for web —
and the web app's 700 tests are still green.

### A2 — Feature parity

**Scope:** every screen — Today (with the overdue `TakenTimePrompt` and dose correction), Medicines
and nested Schedules (create, revise-by-supersede, stop, alternating regimens), As-needed with all
four safety states and the two-step override, Inventory, Export (CSV, printable, JSON
backup/import/wipe), Household (join code, devices, revoke, leave, delete), Diagnostics. Plus the
sync status indicator and the safety warning banner.

**Exit gate:** the parity checklist is complete; a two-device join works from a real Android phone,
and cross-device propagation is inside the PRD's 1.5-second budget.

**Status: code-complete, not device-confirmed.** Every screen in scope is built and wired into a
real `@react-navigation` shell against the real repository/SQLite store from A1 — see
`apps/android/README.md`, "Sprint A2 — feature parity", for the exact list of deviations from web
(Diagnostics is not a port of web's push-testing screen; no time/date-picker or dropdown library
was added, so those fields are validated text input; `window.print()` has no Android equivalent, so
"Print summary" is dropped in favor of the share sheet; PRN's clock-trust check is local-only,
without web's server round-trip) and what's actually been verified (typecheck, lint, the full
Vitest suite, a new Jest + `@testing-library/react-native` suite covering the safety-critical flows,
and a real `expo export` bundle) versus what a device would still need to confirm (the two-device
join + 1.5s propagation half of this exit gate, and everything about how it actually looks/feels on
a phone).

### A3 — The local alarm engine

**Status: code-complete (2026-08-09), not yet device-confirmed.** See `apps/android/README.md`'s
"Sprint A3 — the local alarm engine" for the full account; summary below.

**Scope, as actually built — narrower than originally scoped, because A0/A2 had already built
more of the native layer than this section assumed.** Re-arm receivers and notification channels
were already done (`BootReceiver`, `MedGuardChannels`, all five versioned channels). What A3
actually delivered: horizon materialization on the device (`src/alarms/horizon.ts`); Taken/Snooze
actions through a durable **peek/ack** pair (`readPendingActions`/`ackPendingActions`, replacing
the destructive `drainPendingActions()` this plan originally specified — a destructive drain loses
the tap if the app dies between reading it and writing the resulting log); bounded snooze, shipped
as a full synced `DoseSnooze` entity rather than deferred to A4 (`0003_alarms.sql`, append-only,
signed off at `MAX_SNOOZE_COUNT = 3`); the "alarms unarmed"/"sync stale" degradation states
(`alarmHealth.ts`, a new `getLastSyncedAt`/`setLastSyncedAt` primitive in `packages/store`); and
battery-optimization/DND onboarding (`AlarmSetupChecklist.tsx`, including AD7's explicit,
honest statement that OEM autostart managers cannot be granted programmatically).

**Deliberately deferred to A4:** the `HeadlessJsTaskService` this section originally specified for
"the app process is fully dead." A3 instead drains on app launch, on `AppState` → `'active'`, and
on a new native `onPendingAction` event for a live JS runtime — covering the common
merely-locked-phone case. A4 builds the headless bootstrap once, shared with the FCM data-message
handler it needs regardless, rather than building it twice.

**Exit gate:** the 25-hour locked-phone dry run (existing manual QA item 2) — every alert fires,
every one auto-stops, none repeats, zero touches. Not yet run; this sandbox has no Android SDK or
device. Code-level verification (typecheck, lint, full repo Vitest at 926/926 including the
100%-branch gate on the new `snooze.ts`, the Android Jest suite, `expo export`, `expo prebuild`)
is green.

### A4 — Server Sprint 5

**Status: code-complete (2026-08-09), not yet device-confirmed.** The `runDurableObjectAlarm` half
of the exit gate passes; the two-real-phone half is waiting on hardware and a Firebase project.

**Scope, as built:** the FCM sender (`apps/api/src/push/fcm.ts`), the provider-blind fan-out
(`dispatch.ts`), the DO dose-alarm chain and escalation (`do/doseAlarms.ts`), the missed-dose sweep
(AD6), low-stock push, probe-route removal (AD8), both clients' receive paths, and the
`HeadlessJsTaskService` A3 deferred. `DoseSnooze` the *entity* — and its migration,
`0003_alarms.sql` — shipped in A3; what A4 added is the DO reading it to stop an escalation, plus a
server-side refusal of a fourth snooze, since a snooze is the one client-written record that
silences an escalation.

**The known risk did not materialise.** FCM HTTP v1's RS256 service-account signing is ~40 lines of
`crypto.subtle` on workerd (`importKey('pkcs8', …)`, `RSASSA-PKCS1-v1_5`, an access token cached
against its 1-hour life), and it was in place inside a session — the same shape as the VAPID work
before it, and much less trouble than the aes128gcm encryption Sprint 5 warned about.

**Two things worth reviewing, both decided rather than discovered:**

1. **AD6's 60-minute first escalation was resolved to 15** — see AD6 above. A4 could not start
   without settling it.
2. **FCM is optional at every layer.** No `FCM_SERVICE_ACCOUNT` secret → `fcm` devices are skipped
   with a reported reason and `webpush` devices are unaffected. No `google-services.json` →
   `withMedGuardAlarms.ts` omits the Firebase Gradle plugin and the messaging service, and
   `alarmHealth` reports `no_server_backstop` as a *risk*, not a blocker. This keeps
   `.github/workflows/android-apk.yml` (a GitHub-hosted runner with no secrets) producing a working
   sideloadable APK, which mandatory Firebase would have broken. Verified by running
   `expo prebuild` both ways.

**What the shared code now carries.** `packages/store/src/pendingActions.ts` is the Android
`AlarmEngine`'s tap-to-dose conversion, lifted out so the web service worker's captured taps go
through the same repository transaction — AD2's rule applied to the second client rather than
re-implemented for it. `packages/shared/src/push.ts`'s `describePush` does the same for the
notification's wording, which Kotlin reads from the message's data map because it cannot call it.

**Exit gate:** escalation fires at exactly the configured boundary under `runDurableObjectAlarm`
(**passing** — `apps/api/tests/alarms.test.ts` asserts the armed instant, not just the behaviour),
**and** a real escalation push lands on a second real phone after the first one ignores a dose for
15 minutes (**not yet run**; needs two phones, a Firebase project, and the `FCM_SERVICE_ACCOUNT`
secret set with `wrangler secret put`).

### A5 — Shabbat on native

**Status: phases 1 and 2 code-complete (2026-08-13), not yet device-confirmed or luach-checked.** No
longer blocked: the halachic questions are answered in `docs/halachic-decisions.md` — as working
placeholders pending an actual rav, so everything below ships against a placeholder ruling and
gets revisited if a real answer differs.

**Scope, as built (phase 1 — mode and alarms):**

- **Zmanim in the Worker only** (PRD §3). `apps/api/src/shabbat/zmanim.ts` is the sole file that
  imports `@hebcal/core`; `publish.ts` writes the result as `ShabbatWindow` records that devices
  pull like anything else. Clients never compute — they read the same windows the Durable Object
  acts on, so a phone and the server cannot disagree about whether it is Shabbat.
- **Windows, not days.** A window opens at a candle lighting and closes at the next Havdalah, so a
  chag adjacent to Shabbat comes out as *one* continuous window and three-day continuity needs no
  special case anywhere downstream.
- **`packages/shared/src/shabbat.ts`** — the single predicate set (`shabbatModeAt`,
  `shabbatPhaseAt`, `upcomingWindows`) that the DO, the Android alarm horizon and both UIs read.
  Held at 100% branch coverage alongside `snooze.ts`.
- **The DO honours the mode**: `kind: 'shabbat'` pushes (no action buttons), no escalation, no
  machine-written `missed`, and a `pending_shabbat` `IntakeLog` written at dose time for the
  reconciliation that phase 2 will build. The web burst (10 pushes ~1.1s apart) is a schedule held
  in DO SQLite and drained by the same chain, so every push is assertable under
  `runDurableObjectAlarm`; `fcm` devices get exactly one (AD3).
- **Android** arms Shabbat-window doses on `shabbat_v1` at the configured chime length; the
  reconcile diff now includes the channel, so Shabbat starting between two passes re-arms rather
  than leaving a dose on the weekday channel with "Taken"/"Snooze" on it. `listArmedAlarms` reports
  the channel for that reason.
- **Both clients** get a Shabbat screen: the config form, and the next 8 weeks of computed times
  in the household's timezone, for checking against a luach. Automation defaults to *off* on a new
  config — nothing changes how alarms behave until someone has verified the times.
- **The setup checklist** gains a "Before Shabbat" section (the `shabbat_v1` channel's own sound
  setting, and DND access), since Android treats each channel's sound as a separate user setting.

**Two things worth knowing:**

1. **Hebcal applies municipal candle-lighting customs when a `Location` has a recognised name** —
   40 minutes for "Jerusalem", 30 for "Haifa" — silently overriding the configured offset. The
   location is therefore constructed anonymously, so the household's own setting wins, and there
   is a test asserting exactly that. The default remains the PRD's 18 minutes, which is *not* the
   Jerusalem custom: this is a setting on the screen for that reason.
2. **Bundle cost of hebcal in the Worker:** 1298 KiB raw, 248 KiB gzipped (`wrangler deploy
   --dry-run`), comfortably inside the limit. `temporal-polyfill` runs on workerd with no trouble.

**Phase 2 — the Motzei Shabbat reconciliation sheet — is also code-complete (2026-08-13):**

- **`packages/shared/src/shabbatReconciliation.ts`** builds the list from the *window*, not from
  the `pending_shabbat` logs: a dose whose alert never fired (server never woken, phone offline all
  of Shabbat) still has to be asked about, and a per-log listing would silently omit it.
- **The sheet opens itself** on first launch after Havdalah (PRD §3's wording), replacing the tab
  content rather than covering it so "Later" and the navigation are always one tap away. Dismissal
  is remembered per device *and* per window, in local-only storage — one caregiver tapping "Later"
  must not suppress the prompt on the other's phone, and the next Shabbat is a different question.
- **One transaction per sheet** (`MedGuardRepository.reconcileShabbatDoses`): a caregiver taps "all
  given as scheduled" once, so a crash halfway through a loop of separate writes must not leave
  half a Shabbat recorded. Answers supersede the server's placeholder rather than editing it, and
  stock catches up through the ordinary ledger.
- **Two caregivers cannot double-log.** `HouseholdDO.applyBatch` refuses an `intakeLog` whose
  `supersedesId` names a log something else already supersedes (`already_superseded`), checked
  *before* the safety re-check so a race is not reported to the household as a safety event. The
  losing device drops its local write (`discardLocalLog`) rather than keeping a dose the record
  does not have — the only place anything deletes an intake log, and only ever one the server
  refused.
- **Retroactive PRN entry** assesses the guard as of when the dose was *given* (`clockAt`), which
  is exactly what the Durable Object re-checks on push. When it binds, the dose is still recorded —
  it happened — but only with a written reason attached (safety invariant 5).

**One deviation from the plan, worth naming:** per-item answers are inline on each row (given /
not given, time, quantity) rather than opening the existing `DoseCorrection` component. That
component corrects an *existing* log and requires a note; roughly half the sheet's rows have no log
to correct, and mixing a modal for some rows with inline controls for others would be worse than
either. `DoseCorrection` remains the path for correcting a reconciliation afterwards, from the Log
screen.

**Exit gate:** three-day chag continuity (**passing** — `apps/api/tests/zmanim.test.ts` asserts
Rosh Hashana 5787 running into Shabbat as one 48-hour-plus window, and Israel/diaspora divergence
on Shmini Atzeret); **eight weeks of times checked against your luach on the Shabbat screen** (not
yet done, and nothing here is trustworthy until it is); a weekday 25-hour dry run in simulated
Shabbat mode with zero touches and no escalation emitted (**not yet run** — needs a device).

### A6 — Hardening and release

**Scope:** Play Console restricted-permission declarations with demo videos (`USE_EXACT_ALARM`,
`USE_FULL_SCREEN_INTENT`, the `mediaPlayback` foreground service); EAS build and submit wired into
CI — ~~`.github/workflows/ci.yml`~~ done differently: a separate `.github/workflows/android-apk.yml`
(plain Gradle build, no EAS, `workflow_dispatch` only, landed 2026-08-07 — see status note above);
EAS build/submit specifically (for Play Store release, as opposed to a sideloadable debug APK) is
now wired in-repo via `apps/android/eas.json` and `.github/workflows/android-eas-release.yml`, but
still awaiting its first authenticated Expo/Play run; accessibility and font-scaling pass (Android's system font scale needs deliberate
`allowFontScaling` handling in React Native, and the 3 AM ergonomics requirement makes it
non-optional); performance with 12 months of logs; `docs/runbook.md` additions for Android-specific
failure modes.

**Exit gate:** an internal-testing-track build installed on both real phones, every manual QA item
below green.

---

## Manual QA — what automation cannot cover

Extends the existing list in `medguard-sprint-plan.md` rather than replacing it.

1. **The A0 locked-phone chime** — 45 seconds, alarm volume, auto-stops, zero touches. The premise.
2. **A 25-hour dry run on Android**, phone locked and screen off, weekday. *Do not let the first
   real test be an actual Shabbat.*
3. **A real escalation between two phones over cellular** — the first caregiver ignores a dose, the
   second gets the escalation at exactly the configured boundary, and acknowledging on either one
   stops it on both.
4. **The notification-action path with the app force-stopped** — tap "Taken" on the lock screen with
   the process dead, and confirm the dose appears with the *tap* timestamp, not the drain timestamp.
5. **After a reboot**, and **after a timezone change mid-schedule.** Both are silent failures.
6. **Is the native chime actually loud enough to wake you at 3 AM?** The web burst took four rounds
   of tuning to answer this; the native chime deserves the same scrutiny, not an assumption that
   45 seconds of alarm audio settles it. ✅ **Confirmed 2026-08-11** — audible at 50% alarm-stream
   volume across several real dose-alarm firings this week. No tuning change needed.
7. **The OEM battery-manager gauntlet** — whichever of Xiaomi / Huawei / Samsung / Oppo is actually
   in the household, with the setup checklist followed and then deliberately *not* followed, to see
   what the degraded state looks like.

---

## Compressed reliability verification (emulator + adb)

Items 2, 4, and 5 above don't inherently need 25 real hours or physical hardware — they need
*Doze/process-death edge cases to occur*, and `adb` can force those directly instead of waiting for
them. This is Android's own documented technique for Doze testing, not a workaround. Run it against
an emulator (Google Play or Google APIs system image, any API level ≥ 31) rather than a real phone;
no USB, no waiting, no sandbox-without-an-SDK problem.

**What this does and doesn't prove.** `AlarmScheduler.kt` arms every dose with
`AlarmManager.setAlarmClock()`, not `setExactAndAllowWhileIdle` — the strongest exemption AOSP
offers; the OS treats the app as having a user-visible alarm clock and is contractually obligated to
fire it even in deep Doze. So this procedure isn't testing "does Doze eat the alarm" (that should
structurally never happen on stock AOSP); it's testing everything *downstream* of the OS honoring
that contract: does the headless JS task cold-start correctly when the process was killed, does the
notification/full-screen-intent still render, does the chime stream still play, does nothing
duplicate or drop across many cycles. **It cannot exercise item 7.** OEM battery managers
(MIUI/EMUI/One UI/ColorOS) layer their own non-AOSP killers on top of this and are exactly what a
generic emulator system image doesn't have — that check still needs the real device(s).

### Setup

1. Android Studio → Device Manager → create a Pixel-class AVD, **Google Play** system image (not
   "Google APIs" — Play images are closer to what a real device enforces), API 33+ to match
   `POST_NOTIFICATIONS`/`USE_EXACT_ALARM` behavior.
2. Build and install a debug build onto it:
   ```
   cd apps/android
   npx expo prebuild --platform android
   npx expo run:android
   ```
3. In the running app: **Diagnostics tab** → grant notification permission and confirm
   "can schedule exact alarms" via the existing buttons there — `USE_EXACT_ALARM` is install-time
   granted on API 33+, so this is normally already true; the checklist button just confirms it. Also
   run **"Ignore battery optimizations"** — the real two-phone test needs this granted, so the drill
   should too.
4. Arm a real dose 60–90 seconds out using the Diagnostics tab's existing locked-phone alarm spike
   (`onScheduleLockedPhoneAlarm`), or an actual medication schedule if testing the full receive path
   including sync. Lock the emulator (power button icon in the emulator toolbar, or `adb shell input
   keyevent KEYCODE_POWER`).

### Forcing Doze cycles

```
# Tell the OS the device is unplugged — Doze eligibility requires this.
adb shell dumpsys battery unplug

# Jump straight to deep idle instead of waiting through the screen-off + stationary detection.
adb shell dumpsys deviceidle force-idle

# Confirm the state took effect.
adb shell dumpsys deviceidle | grep mState

# Step the Doze state machine forward one stage at a time (IDLE_PENDING -> IDLE ->
# IDLE_MAINTENANCE -> IDLE -> ...). Each call simulates the OS reaching the next natural
# transition. Run this in a loop with a short sleep to cycle through many hours' worth of
# transitions in minutes:
for i in $(seq 1 20); do
  adb shell cmd deviceidle step deep
  sleep 5
done

# Undo when finished — leaving the emulator forced into idle affects anything else you test after.
adb shell dumpsys deviceidle unforce
adb shell dumpsys battery reset
```

Watch `adb logcat` (filter on the app's package, `il.co.fainsilber.med`, and on `AlarmManager`) while
this runs, and check the app's own exportable log afterward (Diagnostics → Share log) for the
alarm's actual fire time against what was armed, and for the headless task's pending-action write.

### Force-stop and reboot (items 4 and 5)

```
# Simulate the app process being killed while an alarm is armed.
adb shell am force-stop il.co.fainsilber.med
# ...then let the armed alarm fire, tap the lock-screen "Taken" action, and confirm in the exported
# log that the dose landed with the *tap* timestamp, not a later drain timestamp.

# Reboot — confirm alarms still fire after BOOT_COMPLETED re-arms them, without reopening the app.
adb reboot

# Timezone change mid-schedule.
adb shell service call alarm 3 s16 Asia/Jerusalem   # or another zone, then back
```

### What still needs a real device

Item 7 (the OEM gauntlet) and any residual doubt about item 2 that this procedure doesn't resolve —
run those on the two real phones before treating A4's exit gate as fully closed. Everything else
above should give strong confidence in well under an hour instead of a blind 25-hour wait.

---

## Signed-off decisions

✅ **AD6 — Missed-dose rule:** Dose becomes missed 3 hours after scheduled time (0–60min silent, 60min first escalation, 60–180min snooze window, 180min missed).

✅ **Snooze parameters:** 20-minute individual snooze duration, `MAX_SNOOZE_COUNT = 3`. Sourced from
`HouseholdSettings.snoozeMinutes` (bootstrap default changed 15 → 20 to match), not hardcoded — the
field existed since Sprint 3 but was read by nothing until A3.

✅ **AD9 — PWA vs Native:** Native app replaces PWA on Android; PWA continues on iOS and web. Migration via Play rollout + in-app guidance.

✅ **A3 — `DoseSnooze` ships as a full synced entity in A3, not deferred to A4.** Shared type + zod
schema + `SyncableTable` member, both `Store` schemas, `0003_alarms.sql`, and the server `TABLES`
entry all land in A3; A4 only adds the DO reading it to stop an escalation. Consequence: the API
must be migrated and deployed before an A3 build reaches a phone, or `doseSnoozes` pushes are
rejected and the outbox blocks.

✅ **A3 — Pending-action drain triggers: app launch, `AppState` → `'active'`, and a live-process
`onPendingAction` event; no `HeadlessJsTaskService` in A3.** The headless case (app process fully
dead) is deferred to A4, where its bootstrap is shared with the FCM data-message handler A4 needs
regardless — see A3's section above for the accepted cost this leaves. **Closed in A4:**
`MedGuardHeadlessService` plus `AppRegistry.registerHeadlessTask('MedGuardPendingActions')`, started
by `NotificationActionReceiver` whenever `MedGuardAlarmsModule.hasLiveRuntime()` is false. Kotlin
still writes nothing — the headless task runs the same `PendingActionApplier` the foreground path
does.

✅ **A4 — AD6's escalation timeline is 15 minutes, not 60.** Settled before A4 began, in favour of
PRD §4 / `DEFAULT_ESCALATION_MINUTES` / A4's exit gate over AD6's own prose. See AD6 above for the
corrected table and the reasoning.

✅ **A4 — FCM is optional at build time and at deploy time.** Absent credentials degrade to
"local alarms only, and the app says so" rather than to a failure. See the A4 section above.

---

## Remaining open questions

1. **Play Store distribution or sideload?** A household of two phones does not obviously need a Play
   listing, and sideloading skips the AD4 review entirely — at the cost of manual updates and
   `USE_EXACT_ALARM` behaving differently.
