# MedGuard PWA — Sprint Plan

**Version:** 2.0
**Basis:** `medguard-prd.md` v2.0
**Supersedes:** Sprint Plan v1.0 (commit `3f18003`, kept in git history)
**Team model:** Claude builds; you guide, decide, review.
**Cadence:** 8 milestone sprints, no fixed dates. A sprint ends when its exit gate passes.
**Progress:** Sprints 0–3 complete in code (last updated 2026-08-03); Sprint 3's production deploy and two-real-phone check still outstanding. Next up: Sprint 4 — Durable Objects, real-time sync, the double-dose guard.

---

## Context

MedGuard is a local-first PWA for multi-caregiver households managing complex pediatric-oncology medication protocols, synced through Cloudflare Workers, with PRN safety guards, inventory tracking, and Shabbat/Yom Tov automation.

Because a dosing error here can harm a child, this plan treats the safety logic — PRN cooldown, daily caps, inventory arithmetic, offline reconciliation — as the highest-value test surface and gates it at 100% branch coverage. The goal is that everything verifiable by machine is verified by `npm test` with no human in the loop, and the short list of things that genuinely need a real device is called out explicitly rather than left implicit.

---

## Decisions

| Question | Decision |
| --- | --- |
| Shabbat chime | **No dedicated device.** Web Push for locked phones; in-app 45s chime engine when foregrounded. Native Android app (Phase 2) solves the locked-device case properly. |
| Shabbat alert style | **Burst of 10 pushes, ~1.11s apart**, shared tag + `renotify`, approximating the PRD's 45s. Started at 3×/15s and was retuned four times against a real Android phone — see Sprint 0 and `docs/platform-capabilities.md`. |
| Auth | **Join code + device token only.** No magic link, no email provider. |
| Devices | **Mixed iOS + Android, Android prioritized.** Native Android planned; no iOS native planned. iOS best-effort. |
| Cloudflare | Account ready. Miniflare for all dev/CI; real deploys from Sprint 3 on. |
| Patients | Schema supports N, UI ships 1. `patientId` is already everywhere; no switcher yet. **Confirmed 2026-08-03: multi-patient is a real future requirement, not a hedge** — keep it a UI change, never let it become a migration. |
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

**D1 — The 45s Shabbat chime cannot reach a locked phone.** Browsers suspend Web Workers when backgrounded; Service Workers cannot play audio at all. On iOS this is absolute. We ship a push burst instead (currently 10×/~1.11s, tuned from real device tests — see `docs/platform-capabilities.md`), plus the full 45s engine whenever the app is foregrounded. Confirmed working on both Android and iOS 18, with iOS still owing the finer-grained device details. *Resolved — plan v1.0 claimed a push can carry a custom notification sound via the Android channel. It cannot: Sprint 0's probe confirmed on-device that the Notification API's `sound` field is never retained by the browser.*

**D2 — Local-first + LWW permits double-dosing.** Nothing stops Mom and Dad both seeing 🟢 and both administering inside the cooldown. **Fix:** the Durable Object is single-threaded per household, so it re-evaluates every PRN log authoritatively before accepting. Violation returns `409 SAFETY_VIOLATION` unless the client sent `override: true` with `overrideConfirmedBy`; either way all devices get a `safety.warning` broadcast. Client checks stay for instant UI; the DO is authoritative.

**D3 — Inventory must not use LWW.** Two offline decrements would silently collapse into one and corrupt refill alerts. **Fix:** append-only `InventoryAdjustment` ledger (`{id, medicineId, delta, reason, createdAt, createdBy}`) applied server-side as `quantity += delta`, deduped by client UUID. `currentQuantity` becomes derived. LWW still applies to genuinely mutable records.

**D4 — `ShabbatConfig` is missing the Israel/diaspora flag.** `@hebcal/core` needs `il`: Israel keeps one day of Yom Tov, the diaspora two. Without it, chag handling is wrong half the year. **Fix:** add `israelHolidays: boolean`, surfaced in settings.

**D5 — Shabbat pushes must carry no action buttons, and reach every caregiver at once instead of escalating.** Standard-mode pushes have "Taken"/"Snooze" lock-screen buttons; tapping one on Shabbat writes data. **Fix:** informational-only pushes while in mode. Reconciliation happens after Havdalah. Per `docs/halachic-decisions.md` Q3, escalation isn't simply turned off — the dose-time burst fans out to *every* registered device in the household on the first push, so there is structurally nothing left to escalate to. This differs from standard mode (Sprint 5), where the initial push may target fewer devices and escalation reaches the rest after 15 minutes unacknowledged.

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

### Sprint 0 — Foundations, harness & capability probe — ✅ **Complete** (2026-08-02)

Prove every test layer works before there's anything to test, and replace platform guesses with evidence from your actual phones.

**Delivered:** monorepo, five-layer test harness (95 tests), CI, both apps deployed — API at `https://medguard-api.fainsilber.workers.dev`, PWA at `https://medguard-web.fainsilber.workers.dev`. Full results in `docs/platform-capabilities.md`.

**What the probe actually found, beyond "yes it works":**
- **Custom notification sound is not supported** — confirmed on-device: a push requesting one showed the field silently dropped. An earlier plan draft (v1.0) assumed it was possible; this settles that with evidence.
- **Server-side push scheduling (DO Alarms) is precise; in-page JS timers are not** — a locked Android phone showed a 54.5s gap in a plain `setInterval`, direct evidence for why the Shabbat design doesn't rely on one.
- **The Shabbat burst was tuned four times from real feedback**, not guessed: 3×/15s → 10×/5s → 10×/~1.67s → 10×/~889ms (too tight — the OS started dropping some of the ten) → 10×/~1.11s (current). See `docs/platform-capabilities.md`.
- **iOS confirmed working (iOS 18)** — push delivery works as expected once the PWA is installed to the home screen. Closes what was the biggest open gap after the initial pass. Not yet captured at the same level of detail as Android (exact latencies, whether the current burst spacing reads as distinct alerts there too) — see `docs/platform-capabilities.md`.
- Two infrastructure problems surfaced and fixed along the way: an npm optional-dependency lockfile bug, and every WebCrypto Web Push library on npm implementing the wrong encryption scheme for iOS (RFC 8291 `aes128gcm` hand-implemented instead — see `apps/api/src/push/encrypt.ts`).

**Scope:** monorepo, TS strict, ESLint (incl. the no-ambient-time rule) + Prettier; Vite/React/Tailwind boots; PWA manifest + SW via `vite-plugin-pwa` (`injectManifest` — Sprint 5 needs a custom SW); Hono `/api/v1/health`; D1 binding + first migration; stub `HouseholdDO`; Vitest workspace; Playwright; GitHub Actions; deploy to a real HTTPS URL (most of these APIs need secure context).

**Capability probe** — one screen, one button per check, results copyable:
- Push with the phone **locked and screen off**, iOS and Android — the critical one
- **Can a notification carry a custom sound at all** (settles D1)
- Background timer survival, iOS vs Android
- `navigator.storage.persist()` — does the OS evict IndexedDB?
- iOS Add-to-Home-Screen requirement for push

**Critical detail:** the DO must be **SQLite-backed** (`migrations: [{ tag: "v1", new_sqlite_classes: ["HouseholdDO"] }]`). KV-backed DOs need a paid plan. Getting this wrong is found late and costs a migration.

**Tests:** one deliberately trivial test per layer — shared unit, Dexie under `fake-indexeddb`, RTL render, `vitest-pool-workers` against real D1, Playwright smoke. Their only job is to prove the harness runs.

**Exit gate:** `npm test` green across all five layers; `npm run e2e` green headless; CI green; probe results recorded in `docs/platform-capabilities.md`. ✅ Met — Android and iOS both confirmed working; iOS still owes a detailed probe run (exact latencies, burst-density behavior) rather than a full re-test — see `docs/platform-capabilities.md`.

**Your time:** ~1 hour running the probe on two phones. The highest-leverage hour in the project. ✅ Done on both.

---

### Sprint 1 — Domain core & local persistence — ✅ **Complete** (2026-08-02)

The highest-value sprint: every safety guarantee traces back to code written here, and it's all pure functions, so it can be tested exhaustively.

**Delivered:** `packages/shared` — `types.ts`, `schemas.ts`, `clock.ts`, `timezone.ts`, `schedule.ts`, `safety.ts`, `inventory.ts`, `logs.ts`, `sync.ts` — plus the Dexie schema and repository layer in `apps/web/src/db/`. All exit gates met.

**Worth knowing:**
- **The 100% branch gate was widened beyond the three modules the plan named.** `timezone.ts` and `logs.ts` are held to the same bar: a DST bug skips or doubles a dose, and a bug in supersession arithmetic makes the rolling-24h count wrong. Both are safety-critical in exactly the way the named three are. `clock.ts` and `sync.ts` too. Enforced in `vitest.config.ts`.
- **`zoneOffsetMs` had a sub-millisecond truncation bug**, caught by a property test rather than an example — the kind of defect that would have surfaced months later as a dose landing a millisecond outside a cooldown window.
- **Inventory is an append-only ledger, not a mutable counter** (the fix for the Last-Write-Wins data-loss problem the plan flagged): stock is the sum of immutable `InventoryAdjustment` deltas, deduplicated by client-generated id, so a sync retry can never double-apply and two offline caregivers can never lose each other's decrement.

**Scope:** types + zod schemas per PRD §5, amended per D3/D4/D6/D8; `Clock` + `IdGenerator`; schedule expansion (`daily`, `interval_days`, `specific_days`, alternating via D6, bounded courses); **schedule versioning** — editing closes the old version (`endDate`, `active: false`) and creates a new one, so past occurrences and logs are never rewritten; PRN cooldown + rolling-24h cap; inventory ledger arithmetic; LWW merge; Dexie repositories with every mutation writing to `syncOutbox` in the same transaction.

**Schema additions beyond the PRD:** compound index `[medicineId+actualTime]` (rolling-24h cap queries) and `[patientId+actualTime]` (Today view); `medicines.archived` — never delete a medicine, logs reference it forever; `syncOutbox.attempts` + `lastError` for retry visibility; `navigator.storage.persist()` requested on first load.

**Watch for — DST.** In a fixed household TZ, a 02:30 dose doesn't exist on spring-forward day and happens twice on fall-back day. Both tested.

**Tests:** table-driven + `fast-check` property tests (*"for any log history and any clock, `canTake` never returns true inside the cooldown"*). DST both directions, leap day, interval crossing month end. Transactional integrity — a failed mutation leaves no orphan outbox row.

**Exit gate:** 100% branch on `safety.ts`/`schedule.ts`/`inventory.ts`; safety-invariant suite green; zero ambient-time lint violations. ✅ Met, and held to a wider set of modules than the three named — see above.

---

### Sprint 2 — Offline PWA: CRUD, PRN safety UI, export — ✅ **Complete** (2026-08-03)

A fully usable single-device app with no backend. First sprint you can evaluate as a product, including the 3 AM ergonomics.

**Delivered:** every screen in scope, wired into a tab shell behind a caregiver-identity gate, with the Sprint 0 capability probe kept reachable as a Diagnostics tab. 503 tests green; coverage gates hold; Playwright offline smoke test passes with no backend running.

**Changed from the plan after using it:**
- **"PRN" is now "As needed" throughout, and it's an explicit choice rather than an inferred one.** The plan carried the clinical term; it means nothing to a caregiver who isn't a nurse. More importantly, as-needed status was originally *inferred* from a medicine having no schedule — which was both invisible in the UI and a latent bug: stopping a medicine's schedule silently made it look as-needed. It's now a stored `asNeeded` field set from a "How is it taken?" question on the medicine form.
- **The schedule editor opens inside the medicine's own row.** It first rendered below the entire medicine list, so with more than a couple of medicines the panel appeared far from the button that opened it and was easy to miss entirely.
- **An overdue dose asks when it was actually taken.** Recording the moment the button was pressed is wrong when a caregiver gave the 08:00 dose on time but only acknowledged the notification at 09:15 — it misstates the history *and* starts the rolling-24h cap window from the wrong instant. Overdue doses now offer "On time", "Just now", or a specific time; on-time doses log in one tap, unchanged, because friction on the common path is what stops people logging at all. Both times are shown on the Today row and carried as separate columns in the CSV and printed summary.
- **`features/prn/` had to be renamed `features/prnDoses/`.** `PRN` is a reserved Windows device name (like `CON`/`AUX`): a directory with that exact name is invisible to native `git.exe` on Windows, though every other tool sees it fine. Recorded here because it's the kind of thing that costs an hour to diagnose from scratch.

---

**Scope:** Medicines / Schedules / Inventory CRUD; Today view (overdue, due now, upcoming, done) with Taken / Skipped / Snooze 15m; PRN screen with three distinct states — 🟢 GREEN, 🔴 LOCKED with live countdown, ⚫ CAPPED (a different problem, so a different message); double-confirm override with mandatory reason, flagged permanently on the log; last-administered banner; **correction flow** — a mistaken log is superseded, never edited, with history viewable (invariant 1); **clock-skew guard** forcing RED (D7); manual stock adjustments; low-stock banner; days-of-supply projection.

**Export ships here, not at the end.** CSV + printable summary. The app is a helper, not the only record — you need paper for hospital visits, and it's a real mitigation if the app fails.

Dark mode and large tap targets from the start, not retrofitted. This gets used half-asleep in the dark.

**Tests:** RTL under a fake clock — countdown rendering, the locked→unlocked flip at the exact boundary, cap boundary at 23h59m vs 24h01m, override needing two deliberate confirmations, skewed clock → RED. Playwright offline smoke with no backend: create medicine → schedule → log → verify decrement.

**Exit gate:** full offline flow passes E2E with the backend down; coverage gates hold. ✅ Met.

**Still standing in for something real, and known to be:** the clock-skew guard compares wall-clock drift against a monotonic reference captured at page load, so it catches a clock changing *during* a session but not one that was always wrong — the real check needs Sprint 3's server time endpoint. The caregiver name is a typed string, not authentication (Sprint 3). The household timezone is auto-detected rather than chosen in a settings screen (Sprint 6 needs one anyway for Shabbat coordinates). "Snooze 15m" is local UI state that a reload clears — there's no alarm engine to re-ring until Sprint 5. Each is commented as such at its call site.

---

### Sprint 3 — Backend: D1, Hono API, join-code auth — ✅ **Complete** (2026-08-03)

**Delivered:** migration `0002_domain.sql`, join-code auth, the sync surface (`bootstrap` / `pull` / `push`), the server time endpoint, `docs/data-handling.md`, and household onboarding in the PWA. 595 tests green; coverage gates hold; 8 Playwright tests including a two-device join.

**Decisions worth knowing:**
- **Per-entity tables, with the write rules factored out once.** The tempting shortcut was a single generic `sync_records` table with a JSON payload — merge logic written once instead of seven times. Rejected because Sprint 4's authoritative PRN re-check and Sprint 5's alarm scheduling both need real server-side domain queries, which a JSON blob makes awkward. Instead each table has real columns *and* the validated record as JSON: the columns are what the server queries, the payload is what round-trips to the client so the SQL mapping cannot silently drop a field. The merge, cursor and dedup rules live in one `tables.ts` config, not seven copies.
- **`seq`, not timestamps, is the sync cursor.** A per-household monotonic counter assigned by the server. Timestamps cannot do this: two devices can write the same millisecond, and a device with a wrong clock could write a record *behind* a cursor a puller had already passed — losing it permanently.
- **DELETE is not supported on the sync path.** The domain has no hard deletes by design (medicines archive, logs supersede), so rejecting it enforces safety invariant 1 at the boundary rather than trusting every client.
- **Onboarding is skippable.** "Use this device on its own for now" is a first-class option. The app is fully usable offline on one device, and a caregiver in a hospital with no signal must never be blocked from logging a dose because a server is unreachable.
- **The clock-skew guard now combines two checks.** The server check catches a clock that was *always* wrong (which a device cannot detect about itself); the existing local monotonic check catches one changed *mid-session* (which a server check from minutes ago would still call fine). Neither subsumes the other, so the more pessimistic answer wins, and any failure to reach the server yields `unverified` — never `trusted`.

**Scope:** D1 migrations mirroring the domain; household / user / device model with `pushProvider` + `pushCredentials` (D8); 6-digit join codes, short-lived, single-use, rate-limited (a 6-digit code is brute-forceable otherwise); device tokens hashed at rest; `/api/v1/` — `bootstrap`, cursor-based delta `pull`, batched idempotent `push`; **server time endpoint** feeding the D7 skew guard; server-side zod validation reusing `packages/shared`; PHI handling documented in `docs/data-handling.md`.

**Tests:** `vitest-pool-workers` against real routes and real D1 — auth happy path, expired code, reused code, **cross-household access denied** (this is where a mistake leaks medical data), malformed payload, idempotent replay of the same outbox batch. Migration tests.

**Exit gate:** integration suite green; **deployed** (Pages + Workers + D1); you can join a household from a second real phone. ⚠️ Partially met — the integration suite is green and the whole flow was verified end to end against a live local Worker with real D1 (household created, code issued, second device joined, a record pushed from one device pulled by the other, reused code rejected). **The production deploy and the two-real-phone check are still outstanding** and need you: see below.

**What still needs you:** create the remote D1 database and apply the migrations to it (`npx wrangler d1 migrations apply medguard --remote`), then deploy. Only then can the second-phone check actually happen. Until the remote database is migrated, the deployed API will fail on every route that touches it.

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

**Scope:** `@hebcal/core` computing candle-lighting and Havdalah from household coordinates, honouring `candleLightingOffsetMins` (18), `havdalahDegreesOrMins`, and `israelHolidays` (D4); state machine `weekday → pre_shabbat_arming → shabbat_active → motzei_pending → weekday`, recovering correctly after a reload mid-Shabbat; **Yom Tov incl. three-day sequences** (chag adjacent to Shabbat); **all-devices fan-out with no escalation while in mode** (D5, per `docs/halachic-decisions.md` Q3) and no action buttons on Shabbat pushes; `pending_shabbat` status; the 3-push burst (D1) plus the 45s foreground engine; **zmanim verification screen** showing the next 8 weeks so you can check against your luach before trusting it; **Do Not Disturb / Focus setup checklist** — a residual gap the app cannot force shut; Motzei Shabbat reconciliation sheet with one-tap bulk confirm, per-item override, retroactive PRN entry, inventory reconciliation, and multi-caregiver race handling so two people can't double-log.

No emergency-interaction affordance ships in this sprint (Q5, deferred) — Shabbat pushes stay informational-only with no exception path.

**Tests:** zmanim fixtures across dates and locations; three-day chag asserting mode stays continuously on; Israel vs diaspora divergence; DST-boundary Shabbatot; state recovery mid-Shabbat; **fan-out test proving every registered household device receives the dose-time burst**; suppression tests proving no escalation push and no action buttons are emitted while in mode; reconciliation E2E.

**Exit gate:** fixtures match published times; **you have verified 8 weeks against your luach** — wrong by 18 minutes is a real problem; three-day chag continuity green; suppression tests green.

---

### Sprint 7 — Hardening, accessibility & release

**Scope:** error handling and retry at every network boundary; Workers observability; accessibility and 3 AM usability pass (contrast, tap targets, font scaling, screen-reader labels on safety-critical controls); Lighthouse PWA audit in CI; new-caregiver onboarding that works without you explaining it; performance with 12 months of logs; `docs/runbook.md` for when sync breaks, push stops, or Shabbat alerts don't arrive; printable emergency protocol sheet; production deploy.

**Full export/import with a tested restore path landed early**, ahead of schedule (2026-08-03) — an untested backup is not a backup, and it was cheap to build once repository-layer transactions already existed. A full JSON backup (medicines, schedules, the complete intake log including corrected-away entries, and the inventory ledger) downloads and re-imports with a preview-before-write step, plus a typed-confirmation "clear all local data" wipe. `docs/data-handling.md` covers what it does and doesn't include. What Sprint 7 still needs to add: the same round-trip proven at 12-months-of-data scale, and folding this into the new-caregiver onboarding story.

**Tests:** Lighthouse + `axe-core` budgets in CI; export→wipe→import round-trip; Today view < 500ms with 12 months of data; full-suite run.

**Exit gate:** all gates green; manual QA checklist below complete.

---

## Manual QA — what automation cannot cover

Everything else runs unattended; these need you and a real device.

1. **Sprint 0 capability probe** on both phones (~1 hr). ✅ Done on both — Android in full detail, iOS confirmed working but without the same granular latency/burst-density numbers yet (`docs/platform-capabilities.md`).
2. **A 25-hour dry run on a weekday, phone locked and screen off** — every alert fires, every one auto-stops, none repeats, zero touches. *Do not let the first real test be an actual Shabbat.*
3. **Real push on a locked iPhone** — ✅ basic delivery confirmed on iOS 18, PWA installed to home screen (`docs/platform-capabilities.md`). Still open: exact latency numbers, whether the current burst spacing reads as distinct alerts on iOS the way it does on Android, and behavior under Focus and Low Power Mode.
4. **Real push on a locked Android phone** — is the burst actually loud enough to wake you at 3 AM? Iterated four times from direct feedback (see Sprint 0 above), including one round that went too far the other way — 10×/~889ms turned out too tight and the OS started dropping some of the ten. Current value is 10×/~1.11s, not yet re-confirmed on-device. Tune `SHABBAT_BURST_COUNT`/`SHABBAT_BURST_SPACING_MS` in `packages/shared/src/push.ts` from what you find.
5. **Zmanim vs. your luach**, 8 weeks (Sprint 6 exit gate).
6. **Two-phone concurrency** — two caregivers tapping the same PRN dose within a second, on real hardware over real cellular.
7. **The 3 AM ergonomics of the Sprint 2 screens on a real phone** — contrast and tap-target size half-asleep in the dark, and whether the as-needed override flow's two confirmations feel like a deliberate safety step or just an obstacle. The RTL tests prove the states are correct; they can't tell you whether the thing is usable at 3 AM by someone frightened and exhausted. Nothing in Sprint 2 has been on a phone yet.

---

## Halachic questions for your rav

Working answers are recorded in `docs/halachic-decisions.md`, but **these are pragmatic placeholders, not an actual ruling** — send the questions to your rav before Sprint 6 ships for real; the lead time on a response is outside your control, so don't wait.

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
