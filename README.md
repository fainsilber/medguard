# MedGuard

A local-first PWA for households managing complex pediatric-oncology medication protocols across
several caregivers — scheduled doses, as-needed doses with cooldown and daily-cap safety guards,
inventory tracking, and (from Sprint 6) Shabbat/Yom Tov automation.

**Status:** Web PWA Sprints 0–4 complete and deployed — real-time WebSocket sync, the server-side
double-dose guard (authoritative Durable Object re-check), offline replay with zero log loss, and
full JSON export/import/wipe are all live. **Sprint 5 (alarms, push and escalation) is
code-complete**, delivered by the Android track as Sprint A4 because the server half is shared by
both clients: the Durable Object now schedules every dose, escalates an unconfirmed one to the
whole household at the configured boundary, writes a missed dose as a real correctable log, and
sends to browsers and phones through one provider-blind fan-out. What it still needs is two real
phones and a Firebase project. See
[`docs/medguard-sprint-plan.md`](docs/medguard-sprint-plan.md) for what's built, what changed along
the way, and what's next.

A native Android client is in active development alongside the PWA — see "Android client" below.
It exists to do the one thing a browser structurally cannot: a real 45-second, alarm-volume, locked-
phone dose chime. Sprints A0–A4 are code-complete, and real-device testing (the only way this app
can be verified end to end) has already found and fixed several bugs: a sync-engine SQLite race, a
PRN clock-trust false positive after device sleep, stale local data on a revoked device, and — most
recently — the on-screen keyboard covering text fields across the app. See
[`docs/android-client-plan.md`](docs/android-client-plan.md) and
[`apps/android/README.md`](apps/android/README.md) for the details.

- **Live PWA:** https://medguard-web.fainsilber.workers.dev
- **API:** https://medguard-api.fainsilber.workers.dev

## Why the code looks the way it does

A dosing error here can harm a child. Three consequences shape almost every design decision:

1. **Time and identity are injected, never ambient.** Domain code takes a `Clock` and an
   `IdGenerator` rather than calling `Date.now()` or `crypto.randomUUID()`. An ESLint rule fails the
   build otherwise. This is what makes cooldowns, DST boundaries, and cap windows deterministically
   testable — and it is why the safety logic can be tested exhaustively rather than hopefully.
2. **The safety-critical modules are gated at 100% branch coverage**, enforced in
   `vitest.config.ts`: `safety.ts`, `schedule.ts`, `inventory.ts`, `timezone.ts`, `logs.ts`,
   `clock.ts`, `sync.ts`. The build fails below it.
3. **Logs are append-only.** A correction never edits or deletes an entry — it appends a new one
   that supersedes it, so a patient's dosing history can't be silently rewritten. Inventory is a
   ledger of immutable deltas for the same reason: a mutable counter loses a decrement when two
   caregivers log offline at once.

The full set of invariants is in the sprint plan.

## Layout

```
packages/shared/   Pure domain logic — no DOM, no Workers globals. Shared by the client and the
                   server so a safety rule exists exactly once, and portable to a future native app.
packages/store/    Storage-agnostic repository + sync engine (extracted from apps/web in Sprint A1),
                   behind a narrow Store port. Dexie-backed for web, SQLite-backed for Android —
                   one implementation of the append-only ledger and outbox rules, not two.
apps/web/          React 18 + Vite PWA. Dexie (IndexedDB) for local-first storage via packages/store.
apps/api/          Hono on Cloudflare Workers, with D1 and a SQLite-backed Durable Object.
apps/android/      React Native + Expo native client (Sprints A0-A2 code-complete; A3, the local
                   alarm engine, is next) — the locked-phone dose alarm the PWA structurally cannot
                   deliver. See apps/android/README.md and docs/android-client-plan.md.
```

## Getting started

```bash
npm install
```

```bash
npm run dev
```

The web app runs at http://localhost:5173. It needs no backend — everything in Sprints 0–2 works
entirely offline against IndexedDB. To run the API too:

```bash
npm run dev:api
```

## Verification

The everyday commands, run from repo root. **[`docs/testing.md`](docs/testing.md)** is the full
picture — why there are six separate runners instead of one, what each layer proves and doesn't,
the coverage gates, and the Android/Maestro layers this short list only gestures at. The short
list of things that genuinely need a real phone is called out in the sprint plan's manual QA
section.

```bash
npm test
```

Every JS/TS layer in one run: domain unit and `fast-check` property tests, Dexie under
`fake-indexeddb`, Worker/D1/Durable Object integration tests in the real workerd runtime, web React
Testing Library component tests (all via Vitest), **and** the Android RN component test suite (Jest
+ `jest-expo`, since jsdom can't execute the real React Native renderer). No Cloudflare account
required. Does not include the Kotlin native-alarm suite (needs a JDK and an `expo prebuild`) —
that runs in `android-apk.yml`, not here.

```bash
npm run test:coverage
```

Same two suites, both with their coverage gate enabled — see `docs/testing.md`'s "Coverage gates"
section for why they're two separate reports (80% global / 100% branch on the safety-critical
modules for Vitest; a separately-measured threshold for the Android RN layer under Jest) rather
than one merged number.

```bash
npm run e2e
```

Playwright against a production build, headless. Includes an offline smoke test that runs the full
create-medicine → schedule → log-a-dose → verify-stock-decrement flow with no backend running at
all, plus real end-to-end coverage of the PRN override confirmation, append-only dose correction,
and push notification delivery via `ServiceWorker.deliverPushMessage`. Does not include Android —
that's Maestro, a manual/emulator step documented separately in `docs/testing.md`.

Also available: `npm run lint`, `npm run typecheck`, `npm run format`.

## A Windows gotcha worth knowing

Never name a file or directory `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, or `LPT0`–`LPT9`. These
are reserved device names on Windows, and native `git.exe` cannot see a path containing one as a
component — `git add` fails with "No such file or directory" while every other tool reads the file
fine. This cost real diagnostic time once already; `features/prn/` is now `features/prnDoses/`.

## Documentation

| Document | What's in it |
| --- | --- |
| [`docs/medguard-prd.md`](docs/medguard-prd.md) | Product requirements — the source of truth for behaviour. |
| [`docs/medguard-sprint-plan.md`](docs/medguard-sprint-plan.md) | Sprint-by-sprint plan, progress, and every deviation from the PRD with its reasoning. |
| [`docs/android-client-plan.md`](docs/android-client-plan.md) | Plan for the native Android client — feature parity, real locked-device alarms, and the server-side push work it absorbs. Signed off; A0-A2 code-complete, A3 (local alarm engine) is next. |
| [`docs/testing.md`](docs/testing.md) | How to run every test layer by hand — Vitest, Jest, Gradle/Robolectric, Playwright, Maestro/adb — what each one proves and doesn't, the coverage gates, and the CI map. |
| [`docs/data-handling.md`](docs/data-handling.md) | What medical data is stored, where, who can reach it, and the known gaps. |
| [`docs/platform-capabilities.md`](docs/platform-capabilities.md) | Real-device probe results — what push and background timers actually do on Android and iOS, measured rather than assumed. |
| [`docs/halachic-decisions.md`](docs/halachic-decisions.md) | Working answers on Shabbat behaviour. **Pragmatic placeholders, not a ruling** — the questions still need to go to a rav before Sprint 6 ships. |
