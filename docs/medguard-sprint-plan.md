# MedGuard PWA — Sprint Plan

**Version:** 2.0
**Basis:** `medguard-prd.md` v2.0
**Supersedes:** Sprint Plan v1.0 (commit `3f18003`, kept in git history)
**Team model:** Claude builds; you guide, decide, review.
**Cadence:** 8 milestone sprints, no fixed dates. A sprint ends when its exit gate passes.

---

## Context

MedGuard is a local-first PWA for multi-caregiver households managing complex pediatric-oncology medication protocols, synced through Cloudflare Workers, with PRN safety guards, inventory tracking, and Shabbat/Yom Tov automation.

Because a dosing error here can harm a child, this plan treats the safety logic — PRN cooldown, daily caps, inventory arithmetic, offline reconciliation — as the highest-value test surface and gates it at 100% branch coverage. The goal is that everything verifiable by machine is verified by `npm test` with no human in the loop, and the short list of things that genuinely need a real device is called out explicitly rather than left implicit.

---

## Decisions

| Question | Decision |
| --- | --- |
| Shabbat chime | **No dedicated device.** Web Push for locked phones; in-app 45s chime engine when foregrounded. Native Android app (Phase 2) solves the locked-device case properly. |
| Shabbat alert style | **Burst of 3 pushes, ~15s apart**, shared tag + `renotify`, approximating the PRD's 45s. Driven by `chimeDurationSeconds`. |
| Auth | **Join code + device token only.** No magic link, no email provider. |
| Devices | **Mixed iOS + Android, Android prioritized.** Native Android planned; no iOS native planned. iOS best-effort. |
| Cloudflare | Account ready. Miniflare for all dev/CI; real deploys from Sprint 3 on. |
| Patients | Schema supports N, UI ships 1. `patientId` is already everywhere; no switcher yet. |
| Hebrew / RTL | Deferred to post-v1 (carried from plan v1.0). |

---

## Safety invariants

Never violated, any sprint. These are the spec the safety test suite is written against.

1. **Intake logs are append-only.** A correction creates a *new* log superseding the old one. Nothing is ever hard-deleted or edited in place.
2. **The app never calculates or suggests a dose.** It records what a human decided. Dosages are entered by the caregiver, full stop.
3. **Fail closed, never open.** If cooldown state is unknown or the clock is untrustworthy, show RED, not GREEN.
4. **Local writes never block on the network.** Every write hits Dexie first, then queues.
5. **Every log records who and when.** No anonymous entries. Every override records who confirmed it.
6. **Visible degradation.** If sync is stale, alarms are unarmed, or clock skew is detected, the UI says so loudly.
7. **No log is ever lost** across an offline→online cycle, and no retry ever double-applies.

---

## Deltas from the PRD

Places where the PRD as written is not achievable or not safe. **Most worth your review attention.**

**D1 — The 45s Shabbat chime cannot reach a locked phone.** Browsers suspend Web Workers when backgrounded; Service Workers cannot play audio at all. On iOS this is absolute. We ship the 3-push burst instead, plus the full 45s engine whenever the app is foregrounded. Dependable on Android; best-effort on iOS (needs home-screen install, system tone only, delivery can lag under Focus/Low Power). *Open question — plan v1.0 claimed a push can carry a custom notification sound via the Android channel. I believe it cannot: the Notification API's `sound` property was never implemented and the channel belongs to Chrome, not to us. Sprint 0's probe settles this with evidence.*

**D2 — Local-first + LWW permits double-dosing.** Nothing stops Mom and Dad both seeing 🟢 and both administering inside the cooldown. **Fix:** the Durable Object is single-threaded per household, so it re-evaluates every PRN log authoritatively before accepting. Violation returns `409 SAFETY_VIOLATION` unless the client sent `override: true` with `overrideConfirmedBy`; either way all devices get a `safety.warning` broadcast. Client checks stay for instant UI; the DO is authoritative.

**D3 — Inventory must not use LWW.** Two offline decrements would silently collapse into one and corrupt refill alerts. **Fix:** append-only `InventoryAdjustment` ledger (`{id, medicineId, delta, reason, createdAt, createdBy}`) applied server-side as `quantity += delta`, deduped by client UUID. `currentQuantity` becomes derived. LWW still applies to genuinely mutable records.

**D4 — `ShabbatConfig` is missing the Israel/diaspora flag.** `@hebcal/core` needs `il`: Israel keeps one day of Yom Tov, the diaspora two. Without it, chag handling is wrong half the year. **Fix:** add `israelHolidays: boolean`, surfaced in settings.

**D5 — Shabbat pushes must carry no action buttons.** Standard-mode pushes have "Taken"/"Snooze" lock-screen buttons; tapping one on Shabbat writes data. **Fix:** informational-only pushes while in mode. Reconciliation happens after Havdalah.

**D6 — Alternating doses conflict with the schema.** PRD §2.2 requires 50mg Mon/Wed/Fri ÷ 25mg Tue/Thu/Sat, but `Schedule` carries a single `dosageQuantity`. **Fix:** model as two schedules for the same medicine, each with its own `daysOfWeek` and quantity; the UI presents them as one alternating regimen.

**D7 — Device clock skew can permit an early dose.** A wrong local clock defeats every cooldown. **Fix:** server-time offset check; implausible skew forces RED with a visible warning (invariant 3).

**D8 — The backend must be client-agnostic from day one.** You plan a native Android client against this same backend. **Fix, cheap now:** `devices` carries a `pushProvider` discriminator (`'webpush' | 'fcm'`) plus `pushCredentials` JSON, so an FCM client needs no migration. Routes versioned under `/api/v1/`. All domain logic stays pure TypeScript in `packages/shared`.

---

## Repository structure

npm workspaces monorepo. The pivotal choice is `packages/shared`: safety rules must give identical verdicts on the client (instant UI) and in the Durable Object (authoritative), so they are written once and tested once, deeply. Keeping it pure also keeps it portable to the future native client.

```
medguard/
├── vitest.workspace.ts · playwright.config.ts · .github/workflows/ci.yml
├── packages/shared/src/        # @medguard/shared — pure TS, no DOM, no Workers APIs
│   ├── types.ts schemas.ts clock.ts sync.ts shabbat.ts
│   └── safety.ts schedule.ts inventory.ts     ← 100% branch coverage gate
└── apps/
    ├── web/                    # Vite + React 18 + TS + Tailwind v4 + vite-plugin-pwa
    │   ├── src/db/ features/ sync/ alarms/ sw.ts
    │   └── tests/ e2e/
    └── api/                    # Hono on Cloudflare Workers
        ├── src/routes/ do/HouseholdDO.ts push/ shabbat/
        └── migrations/ wrangler.jsonc tests/
```

**Stack:** React 18 · Vite 7 · TS 5 strict · Tailwind v4 · Dexie 4 · Hono 4 · Zod 4 · `@hebcal/core` 5 · Vitest 3 · Playwright · `@cloudflare/vitest-pool-workers` · `fake-indexeddb` · `fast-check` · MSW 2 · `@date-fns/tz`.

---

## Cross-cutting rules

Enforced by lint where possible. These exist to make the system testable without a human.

1. **No ambient time.** Domain code never calls `Date.now()` or `new Date()` — it takes a `Clock`. An ESLint rule fails the build otherwise. This is what makes cooldowns, escalation windows, DST boundaries and Shabbat transitions deterministic. Separately, the *trusted* clock is server-corrected (D7).
2. **No ambient identity.** IDs come from an injected `IdGenerator`. Stable fixtures, readable diffs.
3. **Client IDs, server dedupe.** Every mutation carries a client UUID; the server dedupes by it. This is the difference between a resent request and a second dose.
4. **Fixed household timezone.** Wall-clock times stored as local strings + household IANA zone, resolved to instants only at the edges. Device-local time is display-only.
5. **Safety logic is shared, never duplicated.** If a rule lives in `packages/shared`, neither client nor Worker reimplements it.

---

## Test strategy

Everything below runs green from `npm test` and `npm run e2e`, headless, unattended.

| Layer | Tooling | What it proves |
| --- | --- | --- |
| Domain | Vitest + `fast-check` | Cooldown/cap/schedule/inventory invariants hold across generated inputs, not just chosen examples. **100% branch gate.** |
| Persistence | Vitest + `fake-indexeddb` | Repositories, outbox-on-every-mutation, migrations. |
| UI | Vitest + RTL + `user-event` | GREEN/RED/CAPPED states, countdown, double-confirm override, banners. |
| Worker + D1 + DO | `@cloudflare/vitest-pool-workers` | **Real workerd runtime** with real D1 and real Durable Objects locally — no Cloudflare account in CI. `runInDurableObject` / `runDurableObjectAlarm` make alarms deterministic. |
| End-to-end | Playwright (Chromium) | Two contexts = two caregivers. The <1.5s broadcast, offline→online replay, SW registration. |
| Push | Playwright + CDP `ServiceWorker.deliverPushMessage` | Synthetic push into the real service worker — push handling is automatable. |

**Coverage gates:** 80% global; 100% branch on `safety.ts`, `schedule.ts`, `inventory.ts`.

---

## Sprints

### Sprint 0 — Foundations, harness & capability probe

Prove every test layer works before there's anything to test, and replace platform guesses with evidence from your actual phones.

**Scope:** monorepo, TS strict, ESLint (incl. the no-ambient-time rule) + Prettier; Vite/React/Tailwind boots; PWA manifest + SW via `vite-plugin-pwa` (`injectManifest` — Sprint 5 needs a custom SW); Hono `/api/v1/health`; D1 binding + first migration; stub `HouseholdDO`; Vitest workspace; Playwright; GitHub Actions; deploy to a real HTTPS URL (most of these APIs need secure context).

**Capability probe** — one screen, one button per check, results copyable:
- Push with the phone **locked and screen off**, iOS and Android — the critical one
- **Can a notification carry a custom sound at all** (settles D1)
- Background timer survival, iOS vs Android
- `navigator.storage.persist()` — does the OS evict IndexedDB?
- iOS Add-to-Home-Screen requirement for push

**Critical detail:** the DO must be **SQLite-backed** (`migrations: [{ tag: "v1", new_sqlite_classes: ["HouseholdDO"] }]`). KV-backed DOs need a paid plan. Getting this wrong is found late and costs a migration.

**Tests:** one deliberately trivial test per layer — shared unit, Dexie under `fake-indexeddb`, RTL render, `vitest-pool-workers` against real D1, Playwright smoke. Their only job is to prove the harness runs.

**Exit gate:** `npm test` green across all five layers; `npm run e2e` green headless; CI green; probe results recorded in `docs/platform-capabilities.md`.

**Your time:** ~1 hour running the probe on two phones. The highest-leverage hour in the project.

---

### Sprint 1 — Domain core & local persistence

The highest-value sprint: every safety guarantee traces back to code written here, and it's all pure functions, so it can be tested exhaustively.

**Scope:** types + zod schemas per PRD §5, amended per D3/D4/D6/D8; `Clock` + `IdGenerator`; schedule expansion (`daily`, `interval_days`, `specific_days`, alternating via D6, bounded courses); **schedule versioning** — editing closes the old version (`endDate`, `active: false`) and creates a new one, so past occurrences and logs are never rewritten; PRN cooldown + rolling-24h cap; inventory ledger arithmetic; LWW merge; Dexie repositories with every mutation writing to `syncOutbox` in the same transaction.

**Schema additions beyond the PRD:** compound index `[medicineId+actualTime]` (rolling-24h cap queries) and `[patientId+actualTime]` (Today view); `medicines.archived` — never delete a medicine, logs reference it forever; `syncOutbox.attempts` + `lastError` for retry visibility; `navigator.storage.persist()` requested on first load.

**Watch for — DST.** In a fixed household TZ, a 02:30 dose doesn't exist on spring-forward day and happens twice on fall-back day. Both tested.

**Tests:** table-driven + `fast-check` property tests (*"for any log history and any clock, `canTake` never returns true inside the cooldown"*). DST both directions, leap day, interval crossing month end. Transactional integrity — a failed mutation leaves no orphan outbox row.

**Exit gate:** 100% branch on `safety.ts`/`schedule.ts`/`inventory.ts`; safety-invariant suite green; zero ambient-time lint violations.

---

### Sprint 2 — Offline PWA: CRUD, PRN safety UI, export

A fully usable single-device app with no backend. First sprint you can evaluate as a product, including the 3 AM ergonomics.

**Scope:** Medicines / Schedules / Inventory CRUD; Today view (overdue, due now, upcoming, done) with Taken / Skipped / Snooze 15m; PRN screen with three distinct states — 🟢 GREEN, 🔴 LOCKED with live countdown, ⚫ CAPPED (a different problem, so a different message); double-confirm override with mandatory reason, flagged permanently on the log; last-administered banner; **correction flow** — a mistaken log is superseded, never edited, with history viewable (invariant 1); **clock-skew guard** forcing RED (D7); manual stock adjustments; low-stock banner; days-of-supply projection.

**Export ships here, not at the end.** CSV + printable summary. The app is a helper, not the only record — you need paper for hospital visits, and it's a real mitigation if the app fails.

Dark mode and large tap targets from the start, not retrofitted. This gets used half-asleep in the dark.

**Tests:** RTL under a fake clock — countdown rendering, the locked→unlocked flip at the exact boundary, cap boundary at 23h59m vs 24h01m, override needing two deliberate confirmations, skewed clock → RED. Playwright offline smoke with no backend: create medicine → schedule → log → verify decrement.

**Exit gate:** full offline flow passes E2E with the backend down; coverage gates hold.

---

### Sprint 3 — Backend: D1, Hono API, join-code auth — **first deploy**

**Scope:** D1 migrations mirroring the domain; household / user / device model with `pushProvider` + `pushCredentials` (D8); 6-digit join codes, short-lived, single-use, rate-limited (a 6-digit code is brute-forceable otherwise); device tokens hashed at rest; `/api/v1/` — `bootstrap`, cursor-based delta `pull`, batched idempotent `push`; **server time endpoint** feeding the D7 skew guard; server-side zod validation reusing `packages/shared`; PHI handling documented in `docs/data-handling.md`.

**Tests:** `vitest-pool-workers` against real routes and real D1 — auth happy path, expired code, reused code, **cross-household access denied** (this is where a mistake leaks medical data), malformed payload, idempotent replay of the same outbox batch. Migration tests.

**Exit gate:** integration suite green; **deployed** (Pages + Workers + D1); you can join a household from a second real phone.

---

### Sprint 4 — Durable Objects: real-time sync & the double-dose guard

**Scope:** `HouseholdDO` on the **WebSocket Hibernation API** (`state.acceptWebSocket()`) so idle connections survive eviction without burning duration budget; broadcast on every accepted mutation; client sync engine with outbox drain, LWW merge, exponential-backoff reconnect, offline queueing, resume-from-cursor catch-up after hours or days offline; **the D2 double-dose guard**; D3 ledger applied server-side; **sync status always visible** — synced / pending N / offline / error, never silent (invariant 6).

**Tests:** `runInDurableObject` units; two WS clients asserting fan-out; **the race test** — two clients submitting the same PRN dose concurrently, asserting exactly one accepted and both warned; device offline 24h with 20 local logs → all sync, no duplicates, no loss; concurrent inventory decrements → correct final count; Playwright two-context test asserting propagation **under the PRD's 1.5s budget**.

**Exit gate:** race test green; 1.5s budget met in E2E; deployed and verified across two real phones.

---

### Sprint 5 — Alarms, Web Push & escalation

**Scope:** Web Worker timer engine, **drift-corrected** (`setTimeout` drifts badly over hours) and rearming from schedules on reload rather than persisting timers; HTML5 Audio chime; VAPID keys as Worker secrets; subscription lifecycle incl. expiry and re-subscription; SW `push` + `notificationclick` with "Taken"/"Snooze" lock-screen actions; DO Alarms for dose pushes, cancelled and rescheduled when a schedule is edited; 15-minute unacknowledged escalation to all caregivers, stopping immediately on acknowledgement from any device; low-stock push; **dedupe by occurrence ID so the local engine and push can't both fire the same dose**; bounded snooze count; missed-dose detection.

**Known risk — spike this first.** The standard `web-push` npm package depends on Node crypto and does not run on workerd. VAPID JWT signing and aes128gcm encryption must use WebCrypto (`webpush-webcrypto`, or ~150 lines hand-rolled). This is the single most likely thing to slip.

**iOS gate:** onboarding detects iOS-without-home-screen-install and explains push won't work until installed. Android needs no gate.

**Tests:** `runDurableObjectAlarm` for scheduling and escalation-at-15-minutes; payload/encryption units with a fixed keypair; `fetch` mocked at the push-endpoint boundary; Playwright + CDP `deliverPushMessage` asserting a real notification renders and its actions dispatch.

**Exit gate:** escalation fires at exactly the configured boundary; a real push lands on a real Android device.

---

### Sprint 6 — Shabbat & Yom Tov automation

Most domain-sensitive sprint. Correctness is measured against the Jewish calendar, so it's tested against fixtures and then against your luach.

**Scope:** `@hebcal/core` computing candle-lighting and Havdalah from household coordinates, honouring `candleLightingOffsetMins` (18), `havdalahDegreesOrMins`, and `israelHolidays` (D4); state machine `weekday → pre_shabbat_arming → shabbat_active → motzei_pending → weekday`, recovering correctly after a reload mid-Shabbat; **Yom Tov incl. three-day sequences** (chag adjacent to Shabbat); escalation and action-button suppression while in mode (D5); `pending_shabbat` status; the 3-push burst (D1) plus the 45s foreground engine; **zmanim verification screen** showing the next 8 weeks so you can check against your luach before trusting it; **Do Not Disturb / Focus setup checklist** — a residual gap the app cannot force shut; Motzei Shabbat reconciliation sheet with one-tap bulk confirm, per-item override, retroactive PRN entry, inventory reconciliation, and multi-caregiver race handling so two people can't double-log.

**Tests:** zmanim fixtures across dates and locations; three-day chag asserting mode stays continuously on; Israel vs diaspora divergence; DST-boundary Shabbatot; state recovery mid-Shabbat; suppression tests proving no escalation push and no action buttons are emitted while in mode; reconciliation E2E.

**Exit gate:** fixtures match published times; **you have verified 8 weeks against your luach** — wrong by 18 minutes is a real problem; three-day chag continuity green; suppression tests green.

---

### Sprint 7 — Hardening, accessibility & release

**Scope:** error handling and retry at every network boundary; Workers observability; accessibility and 3 AM usability pass (contrast, tap targets, font scaling, screen-reader labels on safety-critical controls); Lighthouse PWA audit in CI; **full export/import with a tested restore path** — an untested backup is not a backup; new-caregiver onboarding that works without you explaining it; performance with 12 months of logs; `docs/runbook.md` for when sync breaks, push stops, or Shabbat alerts don't arrive; printable emergency protocol sheet; production deploy.

**Tests:** Lighthouse + `axe-core` budgets in CI; export→wipe→import round-trip; Today view < 500ms with 12 months of data; full-suite run.

**Exit gate:** all gates green; manual QA checklist below complete.

---

## Manual QA — what automation cannot cover

Everything else runs unattended; these need you and a real device.

1. **Sprint 0 capability probe** on both phones (~1 hr).
2. **A 25-hour dry run on a weekday, phone locked and screen off** — every alert fires, every one auto-stops, none repeats, zero touches. *Do not let the first real test be an actual Shabbat.*
3. **Real push on a locked iPhone** — CDP proves our handler is correct, not that APNs delivers. Test with the PWA installed, and under Focus and Low Power Mode.
4. **Real push on a locked Android phone** — is the 3-push burst actually loud enough to wake you at 3 AM? Tune `chimeDurationSeconds` from what you find.
5. **Zmanim vs. your luach**, 8 weeks (Sprint 6 exit gate).
6. **Two-phone concurrency** — two caregivers tapping the same PRN dose within a second, on real hardware over real cellular.

---

## Halachic questions for your rav

**Send these now** — they're needed before Sprint 6 and the lead time is outside your control. Answers get recorded in `docs/halachic-decisions.md` so the reasoning survives the code.

1. Is a device that plays audio automatically, fully pre-programmed before Shabbat, acceptable? Does it change if the trigger is a server push from outside rather than a local timer?
2. Is the Motzei Shabbat reconciliation model acceptable — doses given on Shabbat but logged only after Havdalah?
3. If a dose is missed and a caregiver must be alerted, is any escalation permitted? (*Pikuach nefesh* considerations likely apply, but you want that stated rather than assumed.)
4. Is a *grama* (indirect action) mechanism required for anything?
5. May a caregiver dismiss or interact with a notification on Shabbat in an emergency, and should the UI make that path explicit?

---

## Verification

```bash
npm test
```

All layers: domain unit + property tests, Dexie under `fake-indexeddb`, RTL components, and Worker/D1/Durable Object integration in the real workerd runtime. No Cloudflare account required.

```bash
npm run e2e
```

Boots `wrangler dev` + Vite preview, runs Playwright headless — two-caregiver sync, offline replay, CDP push delivery.

```bash
npm run test:coverage
```

Enforces 80% global and 100% branch on the three safety modules. Fails the build below either.

CI runs all three on every push. From Sprint 3, each sprint also ends with a real deploy.

---

## Working agreement

- **Carryover is honest.** Unfinished work moves to the next sprint and displaces something. Nothing is quietly declared done.
- **One exception to sprint boundaries:** a safety bug — anything letting a dose be given early, or losing a log — interrupts whatever is in flight.
- **Decisions get written down.** `docs/decisions.md` for technical, `docs/halachic-decisions.md` for halachic. In four months neither of us will remember why.
