# Testing

Six runners prove this repo, not one: Vitest, Jest, Gradle/Robolectric, Playwright, Maestro, and
raw `adb`. This document says why there are six and not fewer, exactly what each one covers, and —
just as important — what each one cannot prove. Linked from the README's Verification section,
which stays trimmed to the everyday commands.

## Why six runners and not one

- **Vitest can't run the RN renderer.** `apps/android/src`'s screen tests need `jest-expo`'s
  preset — the NativeModule/TurboModule mocks the real React Native renderer requires — which
  jsdom and Node can't provide. Vitest owns everything else: `packages/shared`, `packages/store`,
  `apps/web`, `apps/api`, and the pure/native-free half of `apps/android/src` (see "Coverage
  gates" below).
- **Vitest's coverage provider is istanbul, not v8**, specifically so `apps/api`'s tests can be
  covered at all: the v8 provider needs `node:inspector`, which does not exist in workerd, so it
  silently collects nothing from the Worker and Durable Object tests — exactly the code that
  proves the server-side double-dose guard. istanbul instruments at transform time and works in
  every environment this repo tests in (`vitest.config.ts`'s own comment says the same).
- **Kotlin needs a JDK and `expo prebuild`'s generated `android/` project**, neither of which
  `ci.yml` has (by design — it's a fast Node-only job). `android-apk.yml` has both, because it
  already needs them to build the APK.
- **Maestro needs a running Android emulator or device.** Nothing else in this repo can drive a
  real notification tap, a real `adb root`, or a real reboot broadcast.

## The three everyday commands

```bash
npm test
```

Runs Vitest across all five projects (`shared`, `store`, `web`, `api`, `android`) **and** the
Android Jest suite (`npm run test:jest --workspace=@medguard/android`) — this is genuinely "all
JS/TS layers in one run" now. It does **not** run the Kotlin suite (needs a JDK and `expo
prebuild`) or e2e (needs a browser and, for Android, an emulator).

```bash
npm run test:coverage
```

Same two suites, both with their coverage gate enabled — see "Coverage gates" below for what each
one covers and why they're two separate reports rather than one.

```bash
npm run e2e
```

Playwright, headless, against a real production build (`vite build` + `vite preview`) and a real
`wrangler dev` — most specs stub `apps/api` via `page.route()`, but the server itself is always
running, since `live-sync.spec.ts`'s WebSocket test can't be intercepted by `page.route()` at all.
Does not touch Android — Maestro is a separate, manual step (see below).

## Layer by layer

### Vitest — `packages/shared`, `packages/store`, `apps/web`, `apps/api`, and part of `apps/android`

```bash
npx vitest run                                    # every project
npx vitest run --project web                      # one project: shared | store | web | api | android
npx vitest --project android                      # watch mode
npx vitest run --coverage
```

Domain logic, `fast-check` property tests, Dexie under `fake-indexeddb`, React component tests,
and — via `@cloudflare/vitest-pool-workers` — the real workerd runtime with real D1 and real
Durable Objects, no Cloudflare account or credentials needed. The `android` project covers exactly
the pure/native-free surface of `apps/android/src`: `alarms/*.ts` (the code that decides whether a
phone rings) and `store/expoSqliteDriver.ts` — both import nothing native, so they run here rather
than under Jest.

Runtime: a few seconds locally; the api project's real workerd startup is the slowest part.

### Jest (`jest-expo`) — Android RN screens and native-adjacent modules

```bash
npm run test:jest --workspace=@medguard/android
npm run test:jest --workspace=@medguard/android -- --watch
npm run test:jest --workspace=@medguard/android -- -t "PrnCard"
npm run test:jest --workspace=@medguard/android -- --coverage
```

Everything under `apps/android/src` that imports `react-native` or an Expo/native module —
screens, hooks that touch `AppState`/`expo-secure-store`/`expo-crypto`, sync/identity/logging.
Named `.test.tsx` even where there's no JSX, by convention (`jest.config.js`'s own comment): the
split is "does it import something native", not "does it render a component". Test doubles for
native modules with no headless equivalent (`expo-sqlite`, `expo-secure-store`, `expo-crypto`,
`expo-file-system/legacy`, `expo-document-picker`, `expo-sharing`, the native alarm module itself)
live in `apps/android/src/testUtils/`.

Runtime: a few seconds.

### Gradle + Robolectric — the native alarm module

```bash
cd apps/android
npx expo prebuild --platform android
cd android
./gradlew :medguard-alarms:testDebugUnitTest
```

Prerequisites this layer fails confusingly without: **JDK 17** (`java -version`; installed via
`actions/setup-java@v4` in CI, `apt-get install openjdk-17-jdk-headless` or equivalent locally),
and the `expo prebuild` step above — the Gradle project doesn't exist until prebuild generates it,
and there's no committed `android/` directory to skip that with (every manifest entry the alarm
layer needs is owned by `plugins/withMedGuardAlarms.ts`, not hand-edited generated output).

Robolectric is mandatory here, not merely convenient: `AlarmPayload`, `ArmedAlarmStore`,
`PendingActionStore` and others use `org.json`, which is a throwing stub ("Method X in org.json.Y
not mocked") on the plain-JVM unit-test classpath with no shadow framework behind it. Ten test
classes cover `PendingActionStore` (invariant 7 — a tap surviving a crash between read and ack),
`NotificationActionReceiver`, `BootReceiver`, `AlarmScheduler` (against `ShadowAlarmManager`),
`AlarmPayload`, `ArmedAlarmStore`, `MedGuardChannels`, `PushTokenStore`, `AlarmReceiver`, and the
pre-existing plain-JVM `ChimeSessionTest`.

**What this cannot prove**: `AlarmScheduler`/`BootReceiver` call `System.currentTimeMillis()`
directly rather than taking an injected clock, so tests here use far-future/far-past instants
rather than a fake "now" the way `packages/shared`'s `Clock`-injected code does — this layer proves
correctness relative to whatever instant the test ran at, not against a controlled clock. And
nothing here touches a real `AlarmManager`, a real notification tray, or a real device's OEM
battery manager — that's what Maestro and the manual QA list below are for.

`android-apk.yml`'s CI step reads the JUnit XML back and fails if fewer than 60 tests were
discovered — a silent Gradle/AGP config regression that stops most tests from running would
otherwise "pass" by running almost nothing.

**A gotcha worth knowing before it wastes a CI cycle**: `src/test/resources/robolectric.properties`
pins every `@RunWith(RobolectricTestRunner)` test to `sdk=34`, independent of `build.gradle`'s
`compileSdk`/`targetSdk` (36). Without it, Robolectric defaults to the manifest's `targetSdk` and
every single Robolectric test class fails at construction time
(`IllegalArgumentException` at `DefaultSdkPicker`) the moment that level is newer than what the
pinned `robolectric:4.13` release ships `android-all`/shadow support for — not a test failure, an
`initializationError` on every class, which is exactly what happened the first time this suite
actually ran anywhere with a real Android SDK (this sandbox has never had one). If `compileSdk`
moves again, this file may need to move with it.

Runtime: a few seconds once Gradle and Robolectric's dependencies are cached; the first run
downloads Robolectric's ~50MB `android-all` jar.

### Playwright — web e2e

```bash
npx playwright test                 # headless, all specs
npx playwright test --ui             # interactive UI mode
npx playwright test --headed
npx playwright test --grep "PRN"
npx playwright show-report           # after a run, opens the HTML report
```

Ten specs in `apps/web/e2e/`: offline smoke (create → schedule → log a dose → stock decrement,
zero backend), household create/join/revoke/leave/delete, live two-device sync, offline replay,
Motzei reconciliation, PRN's two-step override confirmation, dose correction (append-only, never
edited in place), push delivery (`ServiceWorker.deliverPushMessage` into the real built service
worker — see the callout below), backup/restore, PWA manifest/precache checks, and build identity.

**A note on `prn-safety.spec.ts` and `dose-correction.spec.ts`**: both drive `PrnCard`, which
consults `getLocalClockTrust()` (`src/clock/localClockGuard.ts`) — a check that compares elapsed
`Date.now()` against elapsed `performance.now()` since page load to detect a clock that moved on
its own. `page.clock`'s fake timers can desync the two under CI scheduling pressure, false-flagging
the device as untrusted for a reason that has nothing to do with what those specs test. Both use
`support/clockTrust.ts`'s `pinPerformanceClockToWallClock()` to pin `performance.now()` to derive
from the same `Date.now()` the guard reads, rather than avoiding real-clock-dependent screens.

**A note on `push-delivery.spec.ts`**: `Notification`'s `title`/`body`/`tag`/`actions` are getters
on `Notification.prototype`, not own properties on the instance. `page.evaluate`'s structured-clone
return serialization drops prototype getters, so a bare `registration.getNotifications()` comes
back across the CDP boundary as `[{}]` — silently empty-looking, not an error. The spec's
`shownNotifications()` helper reads each field out explicitly, inside the page, before returning.

**Why `playwright.config.ts` sets `channel: 'chromium'`**: Playwright's headless `chromium` project
launches `chrome-headless-shell` by default — a separate, stripped-down build downloaded alongside
full Chromium (`npx playwright install chromium` fetches both; see `playwright-core`'s own registry
source, `options.headless ? "chromium-headless-shell" : "chromium"` unless `channel` is set). The
shell build doesn't deliver on the Notifications/Push/ServiceWorker CDP surface the same way:
`ServiceWorker.deliverPushMessage` returns success with no error, but `showNotification()` never
actually renders anything under it — `push-delivery.spec.ts` timed out polling `getNotifications()`
for the full 30s on every CI retry until this was set. Silent under the shell in every other way
too, which is exactly why it surfaced only once this suite actually ran somewhere real.

Runtime: roughly a minute locally; CI runs with `retries: 2, workers: 1`, which is part of why
`ci.yml`'s job needs 25 minutes rather than 20.

### Maestro + adb — Android device/emulator e2e

Written against the real screens, receivers, manifest `exported` flags and `SharedPreferences`
schemas, but this sandbox has never had `maestro`, `adb`, or an emulator available to run any of it
locally — the first real check happens in `android-apk.yml`'s `maestro` job, which is
`workflow_dispatch`- and label-gated for exactly that reason (see that workflow's own comments).
That job's first seven real runs each caught a problem this had no way to catch locally:

1. **"Artifact not found for name: medguard-release-apk"** — the APK upload was conditional on a
   `workflow_dispatch` input nobody had reason to check, since `workflow_dispatch` is the *only*
   way to trigger this job. Fixed by uploading unconditionally.
2. **"Timeout waiting for emulator to boot"**, after polling `sys.boot_completed` for 6+ minutes
   straight — GitHub-hosted runners have no `/dev/kvm` group access by default, so
   `reactivecircus/android-emulator-runner` fell back to fully unaccelerated software emulation and
   never finished booting inside its timeout. Fixed with the standard udev-rule workaround (that
   action's own documented fix) in an `Enable KVM group permissions` step before the emulator boots.
   Once fixed, the real boot took 44 seconds.
3. **"Config Section Required" on `maestro-subflows/ensure-onboarded.yaml`** — the first genuine
   flow-authoring bug, not infrastructure: `apk install` and `maestro test offline-smoke.yaml` both
   ran, and Maestro requires every flow file to carry its own `appId` + `---` Config Section, even
   one that's only ever reached through another flow's `runFlow:` and never run standalone.
   `relaunch-sanity.yaml` already had one (it *is* run standalone, by `alarm-action.sh`);
   `ensure-onboarded.yaml` didn't, on the assumption that a pure-subflow file wouldn't need one.
   Fixed by adding one there too.
4. **`tapOn` on the "As needed" chip found nothing**, after onboarding, adding a medicine, and
   filling in Name and Strength all ran correctly — genuine UI automation working end to end for
   the first time. The chip was simply off-screen: Name, Strength, five Form chips, and this row
   don't all fit in 640px of portrait height on the emulator's small default skin, and `tapOn`
   doesn't auto-scroll to find an element the way a human eye would. Fixed with
   `scrollUntilVisible` before the tap, the same pattern `boot-rearm.yaml` and
   `alarm-notification-action.yaml` already used for Diagnostics' "Arm alarm in 15s" button — this
   file just hadn't needed it yet.
5. **Same story one field later**: selecting "As needed" reveals two more inputs (Min hours
   between doses, Max doses/day), pushing "Save" off-screen too on the same small skin. Fixed the
   same way.
6. **`assertVisible: "Ondansetron"` never matched, even though Save visibly succeeded** —
   `MedicineList` and `PrnCard` both render a medicine's name and strength inside one compound
   `Text` node (`{medicine.name} <Text>{medicine.strength}</Text>`), which the accessibility tree
   flattens to one string ("Ondansetron 4mg"). Maestro's text selectors match the *whole* node
   against the regex, so a bare "Ondansetron" never matched. Fixed by matching `"Ondansetron.*"`
   instead, in both places this flow checks it.
7. **The furthest run yet — `offline-smoke.yaml` fully passed, `boot-rearm.sh` fully passed
   (BootReceiver genuinely re-armed after a real `BOOT_COMPLETED` broadcast) — then
   `alarm-action.sh` failed its own first assertion**: `PendingActionStore` was empty immediately
   after the broadcast that should have populated it, even though `am broadcast` itself reported
   success. Root cause was the script, not the app: it killed the app with `adb shell am
   force-stop`, which puts an app into Android's "stopped" state — the OS then refuses to deliver
   *any* broadcast to it, including an explicit one aimed at it by component name, until it's
   explicitly relaunched. That's a real platform mechanism (stopping a force-stopped app from
   silently resurrecting itself), but a much stronger kill than what happens to a real locked
   phone's backgrounded process reclaimed by Android's normal lifecycle — and it defeats the exact
   thing this flow needs to prove. Fixed by killing the process directly (`kill -9` on its PID)
   instead, which doesn't trigger the stopped state.

Treat any claim below about what a flow itself proves as "should be true given the source" until a
run gets far enough to actually exercise it — every fix above came from watching a real run get
one step further and fail at the next one, not from getting a flow fully green yet.

```bash
# Once: boot an AVD — API 33+, google_apis (not google_play — see below), x86_64.
adb root && adb wait-for-device
adb install -r apps/android/android/app/build/outputs/apk/release/app-release.apk

maestro test apps/android/.maestro/offline-smoke.yaml   # standalone, no adb needed
bash apps/android/e2e/boot-rearm.sh                      # drives boot-rearm.yaml + a BOOT_COMPLETED broadcast
bash apps/android/e2e/alarm-action.sh                     # drives alarm-notification-action.yaml + a Taken broadcast
```

Three flows in `apps/android/.maestro/`, shared subflows in `apps/android/e2e/maestro-subflows/`
(deliberately **outside** `.maestro/` — `maestro test <directory>` recursively runs every `.yaml`
file it finds, so a subflow only meant to be `runFlow`'d from another flow can't live alongside the
top-level ones without also being run, and failing, as one itself):

- **`offline-smoke.yaml`** — standalone onboarding, add a medicine, track its stock, log a PRN
  dose, confirm the inventory ledger moved. No `adb`, no household, no scheduled alarm. The one
  flow with no companion shell script.
- **`boot-rearm.yaml` + `e2e/boot-rearm.sh`** — arms a real `AlarmManager` alarm via Diagnostics'
  "Arm alarm in 15s", then the script broadcasts `BOOT_COMPLETED` at the exported `BootReceiver`
  and checks `adb shell dumpsys alarm` for evidence it re-armed. `BootReceiver` is
  `android:exported="true"` with a real intent filter, so this needs no `adb root`.
- **`alarm-notification-action.yaml` + `e2e/alarm-action.sh`** — the flow that justifies the native
  client existing. Arms an alarm, kills the app's process (`kill -9` on its PID, deliberately not
  `am force-stop` — force-stop puts the app into Android's "stopped" state, where the OS blocks
  *every* broadcast to it, including an explicit one by component name, which defeats the exact
  thing this flow needs to prove; confirmed the hard way in CI), then broadcasts a "Taken" action
  straight at `NotificationActionReceiver` — which **is** `android:exported="false"`, so this needs
  `adb root` and a `google_apis` image specifically (`google_play` images aren't rootable, which is
  exactly why the *manual* drill below recommends `google_play` instead — a deliberate divergence).
  Reads
  the SharedPreferences file `ArmedAlarmStore` wrote to recover the occurrenceKey it armed (keyed
  by the occurrenceKey itself, so no app-side logging is needed), then checks `PendingActionStore`'s
  SharedPreferences before and after to prove the tap was captured durably and then drained by
  `MedGuardHeadlessService` with no live JS runtime. **Does not** assert an `IntakeLog` was written:
  the Diagnostics test alarm's `occurrenceKey` is a bare `Crypto.randomUUID()`, not a real
  `${scheduleId}:${dueAt}` occurrence, so the drain correctly finds nothing to resolve it against
  and acks the tap without writing one — the script's own header comment explains this is the
  expected, correct outcome for this synthetic key, not a bug.

Not built: `household-join` (needs a live `wrangler dev` reachable from the emulator at
`10.0.2.2:8787` — more moving parts for the lowest-priority flow) and `backup-restore` (goes
through the OS's SAF file picker, whose UI varies by API level and OEM — brittle for its value,
left as a manual QA line item).

## Coverage gates

Two separate reports, not one, covering two disjoint file sets by design:

- **Vitest** (`vitest.config.ts`): 80% global across `packages/shared`, `packages/store`,
  `apps/web/src`, `apps/api/src`, and the pure/native-free slice of `apps/android/src`
  (`alarms/*.ts`, `store/expoSqliteDriver.ts`). **100% branch** on the safety-critical modules —
  `safety.ts`, `schedule.ts`, `inventory.ts`, `timezone.ts`, `logs.ts`, `clock.ts`, `sync.ts` — plus
  per-file thresholds on `apps/android/src/alarms/{AlarmEngine,alarmHealth,alarmReconciler,horizon}.ts`,
  measured and ratcheted rather than guessed at 100%.
- **Jest** (`apps/android/jest.config.js`): everything else under `apps/android/src` — screens,
  hooks, sync/identity/logging. Global thresholds (`{lines: 72, functions: 62, branches: 58,
  statements: 71}` as of 2026-08-16) measured after the gap-fill tests landed, not guessed.

**The ratchet rule, both gates**: raise a threshold as real coverage improves; never lower one to
make a red build pass. If a change legitimately drops coverage, add the missing test instead.

**Read the reports**: `coverage/index.html` (Vitest) and `apps/android/coverage/index.html`
(Jest) after any `--coverage` run, or download the `coverage-reports` artifact from a `ci.yml` run.
The run summary also gets a compact table (`ci.yml`'s "Coverage summary" step) so you don't need to
open either report just to see the four aggregate numbers.

**Future work, not done**: `nyc merge` across both istanbul outputs would give one true
`apps/android/src` number instead of two disjoint ones. Correctly identified as an accounting
improvement, not a coverage one — nothing is ungated either way — so it's deferred rather than
blocking this work.

**Deliberately excluded from both gates** (composition roots and thin platform adapters — their
correctness is proven by e2e or by the modules they wire together, not by unit coverage):
`apps/web/src/main.tsx`, `apps/web/src/sw.ts` (now genuinely covered by `push-delivery.spec.ts`'s
CDP-delivered pushes, not just asserted-by-comment), `packages/shared/src/runtime/**`,
`apps/android/src/{app/RepositoryContext.tsx,app/useHouseholdSettings.ts,version.ts,api/config.ts,
runtime/**,ui/primitives.tsx}`, `apps/android/src/store/useLiveQuery.ts` (its one real bug has a
regression test at `packages/store/src/notifyingStore.test.ts`), and
`apps/android/src/features/export/shareTextFile.ts`.

## What still needs a real phone

The merged list lives in `docs/medguard-sprint-plan.md`'s "Manual QA" section and
`docs/android-client-plan.md`'s own "Manual QA" section (which extends it) — not duplicated here to
avoid the two drifting apart. In that combined list, this work has **partially** closed two items:

- **"The notification-action path with the app force-stopped"** — `alarm-action.sh` now proves the
  capture-and-drain mechanism end-to-end on an emulator. It cannot prove the *tap timestamp lands
  correctly on a real logged dose*, because that needs a real scheduled occurrence, not the
  Diagnostics test alarm's synthetic key — see that flow's own description above.
- **"After a reboot"** — `boot-rearm.sh` proves `BootReceiver` re-arms cleanly, via a
  `BOOT_COMPLETED` broadcast rather than an actual device reboot (AlarmManager entries are only
  really cleared by a real one). It does not cover "after a timezone change mid-schedule", the
  other half of that same manual QA item.

Everything else on those lists — the 25-hour locked-phone dry run, a real escalation over cellular
between two phones, the OEM battery-manager gauntlet (MIUI/EMUI/One UI/ColorOS, absent from any
generic emulator image), "is it audibly loud enough at 3 AM" — still needs a real device, and the
reason is stated inline with each item in those two documents rather than repeated here.

## Adding a new test: which runner?

```
Does it import react-native or an expo-*/native module?
├─ Yes → Jest (apps/android/src/**/*.test.tsx)
└─ No
   ├─ Pure domain logic, a repository, or a Worker/D1/DO test? → Vitest (*.test.ts)
   ├─ Needs a real browser (a service worker, a WebSocket, CDP)? → Playwright (apps/web/e2e/*.spec.ts)
   ├─ Needs a real Android device/emulator/notification tray? → Maestro (apps/android/.maestro/*.yaml)
   └─ Kotlin? → Gradle/Robolectric (apps/android/modules/medguard-alarms/android/src/test/)
```

Where the test doubles live: `apps/android/src/testUtils/` (native module mocks for Jest),
`apps/web/src/testUtils/` (web-side render helpers), `packages/store/src/testing/` (the
`Store`-conformance suite and `FakeWebSocket` — note `apps/android/src/testUtils/FakeWebSocket.ts`
is a deliberate duplicate of the latter, not a re-export: the `packages/store/testing` barrel also
exports a Vitest-based conformance suite that fails to `require()` under Jest's CommonJS runtime).

## CI map

| Workflow | Job | Runs | Blocking? |
| --- | --- | --- | --- |
| `ci.yml` | `verify` | Lint, typecheck, Vitest + coverage, Jest + coverage, coverage summary, Playwright e2e | Every push to `main` and every PR |
| `ci.yml` | `deploy-api` | Cloudflare deploy | Push to `main` only, after `verify` passes |
| `android-apk.yml` | `build-apk` | Prebuild, Gradle/Robolectric, `assembleRelease` | Every push to `main` and every PR |
| `android-apk.yml` | `maestro` | Maestro flows + adb driver scripts on an emulator | `workflow_dispatch` or a PR carrying the `run-e2e-android` label only — **not** wired to `push` or a schedule yet (see that workflow's own comment on why) |

Artifacts: `ci.yml` uploads `coverage-reports` (7 days, always) and `playwright-report` (7 days, on
failure only — traces are large and only useful when something's actually red). `android-apk.yml`
uploads `native-alarm-test-results` (7 days, always) and `medguard-release-apk` unconditionally on
every event (90 days on a push to `main`, 7 on a manual `workflow_dispatch` run, 3 on a PR) — it
used to skip the upload on `workflow_dispatch` unless a `save_artifact` input was checked, which
broke the first real run of the `maestro` job below with "Artifact not found for name:
medguard-release-apk": `maestro` `needs: build-apk` and downloads this exact artifact, and
`workflow_dispatch` is the only way to trigger `maestro` at all, so gating the upload behind an
easy-to-forget checkbox meant the one event type that actually needed the artifact was also the one
most likely to not have it.
