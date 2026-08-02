# MedGuard PWA — Sprint Plan

**Version:** 1.0
**Basis:** PRD "MedGuard PWA (Internal Working Name)"
**Cadence:** 1-week sprints
**Team model:** Claude builds; you guide, decide, review, and test on real devices
**Your capacity:** ~5–10 hrs/week

---

## 0. How this plan is structured

### Why 1-week sprints
Your time is the scarce resource, not coding throughput. Short sprints mean:
- You never review more than a week's worth of changes at once.
- A wrong assumption gets caught in 7 days, not 14.
- Every sprint ends with something you can actually put on a phone and use.

### Your weekly time budget (per sprint)

| Activity | Hours | When |
|---|---|---|
| Sprint kickoff — confirm scope, answer open questions | 0.5–1 | Start of week |
| Mid-week check — review a partial build, redirect | 1–1.5 | Midweek |
| Code review + device testing | 2.5–4 | End of week |
| Decisions / spec clarifications (async) | 1 | Throughout |
| **Total** | **5–7.5** | Leaves buffer |

Planned at ~75% of your stated ceiling. Real life will eat the rest.

### Definition of Done (every sprint)

- [ ] Feature works **offline** and survives a hard refresh with no data loss
- [ ] Unit tests pass for any pure logic (schedule expansion, cooldown math, dose caps)
- [ ] Manually tested on **at least two real devices** (your phone + one other)
- [ ] No console errors; no unhandled promise rejections
- [ ] Dexie migration written if the schema changed (never a destructive migration)
- [ ] You've reviewed the diff and signed off
- [ ] Sprint notes updated in `/docs/decisions.md` (running ADR log)

### Safety invariants (never violated, any sprint)

These are non-negotiable given the domain (pediatric oncology, multi-caregiver):

1. **Intake logs are append-only.** Corrections create a new log referencing the old one. Nothing is ever hard-deleted.
2. **The app never calculates or suggests a dose.** It records what a human decides. Dosages are entered by the caregiver, full stop.
3. **A safety guard failing closed is acceptable; failing open is not.** If cooldown state is unknown, show RED, not GREEN.
4. **Local writes never block on the network.** Every write hits Dexie first, then queues.
5. **Every log records who and when.** No anonymous entries.
6. **Visible degradation.** If sync is stale, alarms are unarmed, or clock skew is detected, the UI says so loudly.

---

## 1. Critical findings before you commit to the plan

Read this section before Sprint 0. Two items in the PRD are **not buildable as written** on the web platform.

### ✅ Decision — PWA first, native Android app later

The backend (Sprints 6–9) is platform-agnostic — it just talks to whatever client connects over WebSocket/REST. So the client can be extended later without touching the server:

- **v1 ships as a PWA**, per the original plan. Faster to build, no app store review, instantly updatable.
- **A native Android app is a later, optional addition**, not a rewrite. It becomes a second client alongside the PWA, using the same auth, sync, and API. Existing caregivers on the PWA are unaffected.
- This is now tracked as **Phase 2** in the roadmap (§3), unscheduled, to be planned once v1 is live.

### 🟢 Revised priority — reliable sound alert beats screen-on for v1

Screen-on kiosk display is **deferred to Phase 2**. For v1, the bar is narrower:

1. A sound alert **always** fires at the scheduled Shabbat/Yom Tov dose time.
2. It **auto-stops** after a short, fixed duration, no interaction required.
3. It does **not** come back on, repeat, or escalate during Shabbat.

This changes the mechanism, and it's good news. The original design — a Web Worker timer playing audio inside an always-open kiosk page — needed a pre-armed audio unlock and a continuously-held wake lock, both fragile. Since screen-on is no longer required for v1, that architecture isn't needed at all.

**Revised v1 mechanism: server-scheduled Web Push with a notification sound**, reusing the push infrastructure already built in Sprint 9 — no dedicated kiosk device, no wake lock, no in-page audio-unlock ritual:

- The server (Durable Object Alarms, already built in Sprint 9) schedules a push for every Shabbat-mode occurrence.
- The push carries a **custom notification sound** through the Android notification channel. The OS plays and stops it — standard OS notification behavior, nothing the app has to engineer.
- "Doesn't come back on" falls straight out of PRD §2.5: **caregiver escalation is already suppressed during Shabbat**, so there's no retry loop to disable.
- Works on **any caregiver's existing phone** — a dedicated always-on tablet is no longer required for v1 (D6, revised below).

**What this doesn't solve, and Phase 2 will:** a locked, silent, or Do-Not-Disturb'd phone can still suppress or delay an OS notification sound — a genuine residual risk for v1 (risk register R2). A native Android app can request a **full-screen intent notification** — the mechanism alarm-clock and incoming-call apps use — which reliably wakes the screen and plays audio even over Do Not Disturb. That's the real fix for the original "screen turns ON" requirement, and it's native-only; the web platform has no equivalent. It's parked in Phase 2 because it needs a native shell to work at all, not because it's unimportant.

### 🟡 Former audio-unlock problem — now Phase-2-only

The original in-page chime (Web Audio API playing inside a continuously-open kiosk tab) needed a prior user gesture to unlock audio, and lost that unlock silently on any page reload. That problem is specific to the in-page/kiosk architecture and doesn't apply to the push-based notification sound above. It only resurfaces if Phase 2's native app design ever falls back to in-page audio instead of the OS notification/full-screen-intent path.

### 🟡 Halachic questions for your rav

I can build whatever ruling you're given, but these need to be asked before Sprint 10, because they change the design:

1. Is a device that turns its own screen on / plays audio automatically, fully pre-programmed before Shabbat, acceptable? Does it change if the trigger is a server push from outside rather than a local timer?
2. Is a continuously-illuminated kiosk screen that *changes content* automatically acceptable?
3. Is the Motzei Shabbat bulk reconciliation model acceptable — i.e. doses given but logged only after Havdalah?
4. If a dose is missed and a caregiver must be alerted, is any escalation permitted (pikuach nefesh considerations likely apply, but you want that stated, not assumed)?
5. Is a *grama* mechanism (indirect action) required for anything?

Get answers in writing and I'll encode them in `/docs/halachic-decisions.md` so the reasoning survives the code.

### 🟡 Other risks worth naming now

| Risk | Why it matters | Mitigation (and where) |
|---|---|---|
| **Device clock skew** | Cooldown timers computed from a wrong local clock could permit an early dose | Server time offset check + "clock unreliable" warning (Sprint 4, hardened Sprint 7) |
| **iOS PWA limitations** | Push requires Add-to-Home-Screen (iOS 16.4+); background timers are killed aggressively | Probed in Sprint 0; iOS treated as push-only, never as the alarm engine |
| **DST + travel** | `timesOfDay: ["08:00"]` is wall-clock; DST shifts and timezone changes can duplicate or skip a dose | Explicit test cases in Sprint 2 |
| **Sole source of truth** | An app bug during chemo is a real-world harm | Printable/exportable schedule + log from Sprint 3; app is a helper, not the only record |
| **Scope creep from "Child's Device"** | A patient-facing role has different permissions and different emotional design | Deferred to post-v1; v1 has caregiver roles only (confirm in Sprint 0) |

---

## 2. Open decisions — resolve in Sprint 0

The PRD offers alternatives. Recommendations given; you decide.

### Cloud hosting: Cloudflare free tier

Confirmed — the free tier is enough for a single-family app, and it's a better fit than the PRD's original sketch, not just a cheaper one:

- **D1 (Cloudflare's serverless SQLite)** replaces Postgres as the cloud datastore. Free tier gives 5 GB storage and <cite index="8-1">5M rows read/day and 100K rows written/day</cite> — a household logging a few dozen doses a day will use a rounding error of that.
- **Durable Objects** replace the standalone Node.js WebSocket server from the PRD's diagram. <cite index="16-1">Durable Objects are available on the Workers Free plan for building real-time applications like chat or collaboration tools with zero commitment</cite> — and one Durable Object per patient/household is actually a *better* fit for "1 patient → N caregivers" real-time sync than a generic WebSocket server, since each DO holds strongly-consistent state for exactly one household and broadcasts to its connected devices natively.
- **Durable Object Alarms** (or Queues + Cron Triggers) replace Redis + BullMQ for scheduled push jobs — no separate Redis instance needed at all.
- **NestJS doesn't fit this model.** It expects a persistent Node.js process; Workers run short-lived V8 isolates. **Hono** is the practical swap — a thin, TypeScript-first router built for Workers. The mental model (routes, middleware, DI-ish patterns) is close enough to Express/NestJS that it shouldn't cost you real ramp-up time.
- One real constraint: <cite index="15-1">Workers on the free plan are limited to 50 external subrequests per invocation</cite> (calls out to FCM/APNs, etc.) — a non-issue at family scale, worth knowing if this ever grows past one household.

This changes D2–D4 below and reshapes Sprints 6, 7, and 9 (marked inline). **Dexie.js is untouched by any of this** — it's the client's local IndexedDB store (§1.3 of the PRD), always local to the device. D3 is only about the *server's* central datastore, which every device syncs against; Dexie and D1 are two different databases doing two different jobs, not competing choices.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Frontend framework | Vue / React | **React 18 + Vite + TS + Tailwind** — matches your current stack, so zero ramp-up |
| D2 | Backend framework | Express / NestJS / Hono | **Hono on Cloudflare Workers** — see rationale above; NestJS doesn't run in the Workers isolate model |
| D3 | Database | PostgreSQL / MongoDB / D1 | **Cloudflare D1** — replaces Postgres; free tier comfortably covers household-scale volume, zero extra hosting |
| D4 | Hosting | Fly.io / Railway / Render / Cloudflare | **Cloudflare Workers + Pages (free tier)** — Worker for the API, D1 for data, Durable Objects for real-time sync and scheduled alarms, all in one account, no separate DB or Redis host |
| D5 | Auth | Magic link / password / passkey / join code | **Email magic link + long-lived device token + household join code.** Lowest friction, no passwords to reset at 3am |
| D6 | Shabbat primary device | Dedicated kiosk tablet / existing phone | **Existing caregiver phones for v1** — the push-based sound alert needs no dedicated device. Revisit once Phase 2 adds real screen-on; a dedicated tablet becomes worthwhile then, not before |
| D7 | Multi-patient support | 1 patient / N patients | **Schema supports N, UI ships 1** — `patientId` is already everywhere; don't build the switcher yet |
| D8 | Child/patient role | In v1 / deferred | **Defer.** Caregiver roles only in v1 |
| D9 | Timezone model | Device-local / fixed household TZ | **Fixed household TZ** stored in config, with device-local as display only. Avoids travel bugs |

---

## 3. Milestones

| Milestone | Sprint | What you can actually do |
|---|---|---|
| **M0 — De-risked** | S0 | Every unknown platform capability has a yes/no answer from a real device |
| **M1 — Usable solo** | S5 | Full medication tracking, PRN safety, inventory — offline, one device. *Genuinely usable by the family from here.* |
| **M2 — Multi-caregiver live** | S7 | Real-time sync across Dad's and Mom's phones |
| **M3 — Reliable alarms** | S9 | Push, lock-screen actions, missed-dose escalation |
| **M4 — Shabbat capable** | S12 | Autonomous Shabbat/Yom Tov sound alerts (no repeat) + Motzei reconciliation. Screen-on kiosk display is *not* part of M4 — see Phase 2 |
| **M5 — Hardened** | S13 | Backup/export, recovery, real-world soak-tested |
| **Phase 2 — Native Android app** *(post-v1, unscheduled)* | — | Screen-on Shabbat kiosk via full-screen intent; optionally, more reliable exact alarms app-wide. New client only — backend untouched |

**Total: 14 weeks (~3.5 months)** at this cadence for v1 (PWA).

**Phase 2 (native Android app) is additional and unscheduled** — plan it once v1 is live and you've decided whether proper screen-on and exact alarms are worth a native build (Kotlin, or .NET MAUI given your C# background). It reuses the same backend untouched.

### Note — the earlier "Shabbat-first" reordering option is gone

An earlier draft of this plan floated reordering sprints so Shabbat Mode could ship before the backend, since the original kiosk design ran standalone on one device with no server involved. That's no longer true: the current Shabbat sound alert is a **server-scheduled Web Push** (§1), so it depends on Sprint 9's push infrastructure existing first. Sprints must run in the order below — S10–S12 cannot move ahead of S6–S9 anymore.

---

# Sprint 0 — Foundations & Feasibility Probes

**Goal:** Answer every "can the web platform actually do this?" question with evidence from your real devices, and lock the stack decisions.

**Why first:** Blockers 1 and 2 could reshape Phase 4 entirely. Finding that out in week 1 costs nothing; finding out in week 11 costs a month.

### Scope — in
- Repo, TypeScript config, ESLint/Prettier, Vitest, GitHub Actions CI
- Vite + React 18 + TS + Tailwind skeleton; PWA manifest + service worker (vite-plugin-pwa)
- Deploy pipeline to a real HTTPS URL (required — most of these APIs need secure context)
- **Capability Probe page** shipped to your devices, testing live:
  - Audio autoplay after gesture; behavior after simulated page reload
  - Service worker persistence: how long does a background timer survive on iOS vs Android?
  - Notification permission + Web Push registration (VAPID), iOS A2HS flow
  - **Custom notification sound via a push payload, phone locked and screen off** — this is the critical one for Shabbat (§1); confirm it plays and auto-stops on both platforms
  - IndexedDB persistence: `navigator.storage.persist()` — does the OS evict data under pressure?
  - Background sync / periodic sync availability
  - `navigator.wakeLock` — lower priority for v1 (screen-on is a Phase 2 concern, §1), but worth a quick check now so Phase 2 planning isn't starting cold
- Decision log `/docs/decisions.md` (ADR format) with D1–D9 recorded
- Safety invariants written into `/docs/safety.md`

### Scope — out
Any real feature. No Dexie schema. No UI beyond the probe.

### Tasks
1. Scaffold repo, CI, deploy target
2. Build Capability Probe page (one screen, one button per capability, results logged on-screen and copyable)
3. You run it on your phone and spouse's phone
4. Record results in `/docs/platform-capabilities.md`
5. Kickoff call: lock D1–D9
6. Send halachic questions to your rav

### Acceptance criteria
- [ ] `npm run dev`, `test`, and `build` all work clean
- [ ] Probe page live at an HTTPS URL and installable to home screen on iOS and Android
- [ ] Capability results documented per device/OS version
- [ ] D1–D9 decided and recorded
- [ ] Push-triggered notification sound confirmed working with the phone locked, on both your devices

### Your review checkpoint (~2.5 hrs)
Run the probe on every device. This is the highest-leverage 2 hours in the whole project.

### Risks
| Risk | Mitigation |
|---|---|
| Push notification sound unreliable or delayed, phone locked | Confirmed early here rather than assumed; drives how hard S11's Do Not Disturb messaging needs to be |
| iOS more restrictive than expected | Reduce iOS to "push receiver only" role explicitly in the architecture |

---

# Sprint 1 — Dexie Data Layer & Medicines CRUD

**Goal:** A local database that correctly stores medicines and never loses data, with a working add/edit/archive UI.

### Scope — in
- Dexie schema v1 per PRD, **plus these additions:**
  - Compound index `intakeLogs: [medicineId+actualTime]` — required for rolling 24h dose-cap queries
  - Compound index `intakeLogs: [patientId+actualTime]` — required for the Today view
  - `medicines.archived` flag (never delete a medicine — historical logs reference it)
  - `syncOutbox` with `attempts` and `lastError` fields for retry visibility
- Typed repository layer wrapping Dexie (all app code goes through it, never raw Dexie)
- UUID v4 generation, ISO-8601 timestamp helper (single source of truth for "now")
- Migration harness + a written rule: additive migrations only
- `navigator.storage.persist()` requested on first load
- Medicines CRUD UI: list, add, edit, archive
- Seed/demo data script for testing

### Scope — out
Schedules, logging, inventory, sync.

### Tasks
1. Implement schema + migration harness
2. Repository layer with full TS types from the PRD
3. Unit tests: CRUD, archive semantics, migration from empty → v1
4. Medicines list + form UI (name, strength, form, instructions, PRN cooldown, max daily doses)
5. Hard-refresh and offline persistence test

### Acceptance criteria
- [ ] Add 5 medicines, force-quit, reopen — all 5 present
- [ ] Airplane mode: full CRUD still works
- [ ] Archiving a medicine hides it from lists but preserves the record
- [ ] All repository methods unit tested
- [ ] Dexie migration runs cleanly on an existing populated DB

### Your review checkpoint (~2 hrs)
Review the type definitions and repository API closely — everything downstream builds on this shape. Cheapest possible moment to change it.

---

# Sprint 2 — Schedule Engine (Pure Logic)

**Goal:** A tested, pure function that turns a `Schedule` into concrete dose occurrences for any date range — correct across DST, tapers, and mid-course protocol edits.

**Why this is its own sprint:** This is the mathematical core of the app. Bugs here cause missed or doubled chemo doses. It gets built as pure, side-effect-free, exhaustively tested logic before any UI touches it.

### Scope — in
- `expandSchedule(schedule, rangeStart, rangeEnd): Occurrence[]`
- Frequency types: `daily`, `interval_days`, `specific_days`
- Alternating dosage support (50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat) — **note: the PRD requires this in §2.2 but the `Schedule` type has a single `dosageQuantity`. Resolution: model as two schedules for the same medicine, each with its own `daysOfWeek` and quantity.** UI presents this as one "alternating" regimen.
- Start/end date bounds (5-day steroid course, 10-day antibiotic)
- Schedule versioning: editing a schedule **closes the old version** (`endDate = yesterday`, `active = false`) and creates a new one. Past occurrences and logs are never rewritten.
- Timezone/DST: fixed household TZ (D9), tested across both DST transitions
- Occurrence ↔ log matching (which occurrences are already satisfied)

### Scope — out
UI. Notifications. Anything visual.

### Tasks
1. Implement `expandSchedule` with date-fns-tz or Temporal polyfill
2. Implement schedule versioning + edit semantics
3. Test suite (this is the deliverable):
   - Every frequency type, boundary dates inclusive/exclusive
   - Spring-forward and fall-back DST days
   - Schedule edited mid-course — past occurrences unchanged, future updated
   - Alternating-dose regimens
   - `endDate` in the past → no occurrences
   - Leap day, month boundaries, interval crossing month end

### Acceptance criteria
- [ ] ≥ 40 passing unit tests covering the above
- [ ] Editing a schedule provably cannot alter a past occurrence or log
- [ ] DST days produce exactly the right number of doses (no duplicates, no gaps)
- [ ] Function is pure — no Dexie, no Date.now() inside

### Your review checkpoint (~2 hrs)
Read the test names, not the implementation. If a test name doesn't describe a real-world case you recognise, tell me. Add any case I've missed — you know the actual protocols.

---

# Sprint 3 — Today View & Scheduled Intake Logging

**Goal:** The screen the family will actually stare at: today's doses, with one-tap "Taken" / "Skipped" logging.

### Scope — in
- Schedules CRUD UI (built on the Sprint 2 engine)
- **Today view**: chronological list of today's occurrences — overdue, due now, upcoming, completed
- Log actions: Taken (with quantity, defaulted, editable), Skipped (optional reason), Snooze 15m
- Append-only `IntakeLog` writes with `loggedByUserId` (local user for now), `deviceType`
- Correction flow: a mistaken log is superseded, never edited in place; history viewable
- History view: filter by date range and medicine
- **Export**: CSV + printable summary (the paper backup — see risk register)
- PWA install prompt + offline shell

### Scope — out
PRN safety guards (Sprint 4). Inventory (Sprint 5). Alarms (Sprint 8).

### Tasks
1. Schedules CRUD UI (incl. alternating-regimen builder)
2. Today view with live status computation
3. Logging actions + confirmation UX (fast, but not so fast it mis-taps)
4. Correction/supersede flow
5. History + CSV export + print stylesheet
6. Offline end-to-end test

### Acceptance criteria
- [ ] Create a real protocol from your actual current regimen; today's doses appear correctly
- [ ] Log a dose offline → persists → visible in history
- [ ] Correct a mis-logged dose → original still visible in audit history
- [ ] Export produces a file that opens correctly in Excel
- [ ] Print output is legible on one page

### Your review checkpoint (~3 hrs)
Enter a real regimen and use it for a full day. This is the first sprint where usability problems become obvious.

---

# Sprint 4 — PRN Safety Guardrails

**Goal:** PRN medications cannot be given early or over-dosed by accident, and everyone can see who gave the last dose.

**This is the safety-critical sprint.** It gets the most careful review.

### Scope — in
- Cooldown engine: `minHoursBetweenDoses` since last PRN log for that medicine
- **Status states:**
  - 🟢 GREEN — interval elapsed, button enabled
  - 🔴 RED/LOCKED — live countdown ("Locked: 1 hr 14 mins remaining"), button requires double-confirm + explicit override warning
  - ⚫ CAPPED — daily cap reached, distinct from cooldown, distinct message
- Daily dose cap: rolling 24h window (not calendar day) using the `[medicineId+actualTime]` index
- **Override flow**: two-step confirm, mandatory reason note, override flagged permanently on the log and surfaced in history and to other caregivers
- Last-administered banner: "Last given by Mom at 11:30 (500mg)"
- **Clock-skew guard**: detect implausible local time; if detected, force RED and show a warning banner
- Live countdown ticking without draining battery (single interval, not per-card timers)

### Scope — out
Cross-device conflict (a second caregiver logging simultaneously) — that's Sprint 7.

### Tasks
1. Cooldown + rolling-window cap calculation (pure functions, unit tested)
2. PRN card UI with three visual states
3. Override flow with reason capture
4. Clock-skew detection
5. Test suite: exact-boundary cases, DST during a cooldown, cap boundary at 23h59m vs 24h01m, override then next cooldown

### Acceptance criteria
- [ ] Cooldown countdown accurate to the minute; unlocks exactly on time
- [ ] Cap is a true rolling 24h window — verified with a dose at 23h59m ago
- [ ] Override requires two deliberate taps + a reason; cannot be triggered by a single mis-tap
- [ ] Overridden doses visibly flagged in history
- [ ] Unknown/skewed clock → RED, never GREEN (fails closed)
- [ ] Countdown running for 1 hour causes no noticeable battery drain

### Your review checkpoint (~3.5 hrs)
Try hard to break it. Change the device clock. Log doses at boundary times. Attempt to double-tap through the override. Anything that lets you take a dose early is a P0 bug.

---

# Sprint 5 — Inventory & Refill Alerts — 🎯 **M1: Usable Solo**

**Goal:** Stock decrements automatically, and low stock is impossible to miss. At the end of this sprint the app is genuinely usable by your family on a single device.

### Scope — in
- Inventory CRUD (current quantity, refill threshold, unit name)
- **Automatic decrement** on every confirmed Taken log (scheduled and PRN)
- Decrement is **atomic with the log write** (single Dexie transaction — a log must never exist without its stock change, or vice versa)
- Manual adjustments: refill, dropped/lost pill, correction — each with a reason, all append-only
- Low-stock banner + in-app alert ("Mercaptopurine: 5 pills remaining — order refill")
- "Days of supply remaining" projection from the active schedule (nice, and genuinely useful for refill lead time)
- Reversal handling: correcting a log restores stock correctly

### Scope — out
Cross-device low-stock push notifications (needs backend — Sprint 9).

### Tasks
1. Inventory schema + repository + UI
2. Transactional log-and-decrement
3. Manual adjustment flow with audit trail
4. Low-stock detection + banner
5. Days-of-supply projection
6. Tests: decrement, reversal, negative-stock guard, concurrent-tab writes

### Acceptance criteria
- [ ] Logging a dose decrements stock in the same transaction; killing the app mid-write leaves no inconsistency
- [ ] Correcting a log restores the right stock
- [ ] Stock cannot silently go negative — it warns instead
- [ ] Low-stock banner cannot be permanently dismissed while stock is still low
- [ ] Days-of-supply matches a hand calculation

### Your review checkpoint (~3 hrs)
**M1 acceptance:** run the app as your family's real tracker for a few days before Sprint 6 starts. Everything after this point adds convenience and safety-net; the core job is done here.

---

# Sprint 6 — Backend, Auth & Caregiver Binding

**Goal:** A deployed API with accounts, households, and the 1-patient → N-caregivers binding model.

### Scope — in
- Hono on Cloudflare Workers + D1, deployed via Wrangler
- Schema mirroring the client, plus: `users`, `households`, `patients`, `caregiver_bindings`, `devices`
- **Auth**: email magic link → long-lived device token; household join code for adding a caregiver
- Roles: `owner` (full control), `caregiver` (log + view + edit schedules), `viewer` (read-only) — Child/patient role deferred per D8
- REST endpoints for all entities, server-authoritative timestamps
- Server time endpoint (feeds the clock-skew guard from Sprint 4)
- Rate limiting, request validation, structured logging
- **Encryption at rest** for the DB; PHI handling documented in `/docs/data-handling.md`

### Scope — out
Durable Objects for real-time sync (Sprint 7). Push and Alarms (Sprint 9).

### Tasks
1. Wrangler project setup, D1 database binding, migrations (Drizzle ORM — has first-class D1 support)
2. Hono scaffold + route structure
3. Magic-link auth + device tokens + join codes
4. Entity endpoints + authorization guards
5. Integration tests on authorization: caregiver A must not read household B's data
6. Deploy + smoke tests

### Acceptance criteria
- [ ] Sign up, create household, invite a second caregiver via join code, both bound to one patient
- [ ] Authorization tests prove cross-household isolation
- [ ] Magic link works from a phone email client (the flow that usually breaks)
- [ ] API responds over HTTPS with valid certs; secrets not in the repo (Wrangler secrets, not `.env` in git)

### Your review checkpoint (~2.5 hrs)
Review the auth flow and the authorization tests. This is where a mistake leaks medical data.

---

# Sprint 7 — Sync Engine & Real-Time Broadcast — 🎯 **M2**

**Goal:** A dose logged on Dad's phone appears on Mom's phone in under 1.5 seconds, and conflicts resolve predictably.

### Scope — in
- **One Durable Object per household**, holding the live WebSocket connections for every caregiver device on that household and broadcasting state changes between them — the natural unit of consistency here is a household, and a DO is exactly that
- Sync outbox processor on the client: durable queue, exponential backoff, retry, poison-message handling
- WebSocket Hibernation API on the DO side, so idle connections (most of the time, for most families) don't burn compute budget
- Reconnect with backoff; resume from last-seen cursor on the client
- **Conflict resolution per PRD:**
  - `intakeLogs` — append-only event stream, no conflicts by construction
  - `medicines`, `schedules`, `inventory` — LWW on high-precision ISO-8601 `updatedAt`, tie-broken by device ID
- **Inventory is the exception** — LWW on a counter loses concurrent decrements. Resolution: sync inventory as a **delta stream** (`-1 pill, reason: log X`), with absolute values only for manual "set stock to N" adjustments. The household DO folds deltas against D1.
- Cold-start reconciliation: catch-up sync after being offline for hours or days
- Sync status UI: synced / pending N / offline / error — always visible, never silent
- Duplicate-suppression via client-generated UUIDs (idempotent writes)

### Scope — out
Push notifications and scheduled alarms (Sprint 9).

### Tasks
1. Household Durable Object: connection registry, broadcast, D1 writes
2. Client sync outbox + WebSocket client with reconnect
3. LWW implementation + inventory delta stream
4. Catch-up reconciliation
5. Sync status UI
6. **Two-device test matrix**: simultaneous logs, one device offline 24h then reconnects, conflicting schedule edits, simultaneous PRN dose (the dangerous one)

### Acceptance criteria
- [ ] Log on device A → visible on device B in < 1.5s
- [ ] Device offline 24h with 20 local logs → all sync on reconnect, no duplicates, no loss
- [ ] Two caregivers log the same PRN dose within seconds → both logs preserved, and the second caregiver's cooldown UI immediately reflects reality
- [ ] Concurrent inventory decrements from two devices → final count is correct
- [ ] Killing the server mid-sync loses nothing

### Your review checkpoint (~4 hrs)
The heaviest testing sprint. Two phones, airplane mode, deliberate chaos. Budget time for a second round after fixes.

---

# Sprint 8 — Local Alarm Engine

**Goal:** When the app is open, doses alarm on time, reliably, with in-app actions.

### Scope — in
- Web Worker timer engine (drift-corrected — `setTimeout` drifts badly over hours)
- HTML5 Audio chime + configurable volume, with the audio-unlock gesture handling from Sprint 0's findings
- In-app banner notification with "Mark as Taken" / "Snooze 15m", syncing to all devices
- Local Notifications API when the tab is backgrounded but alive
- Missed-dose detection and marking
- Snooze semantics: bounded snooze count, snoozes logged
- Alarm state survives page reload (recompute from schedules, don't store timers)

### Scope — out
Server push and escalation (Sprint 9).

### Tasks
1. Web Worker scheduler with drift correction and a recompute-on-wake path
2. Audio playback layer + unlock state tracking
3. Alarm UI + actions
4. Missed-dose detection
5. Long-run test: 8h continuous, verify no drift and no missed fires

### Acceptance criteria
- [ ] Alarm fires within ±30s of target over an 8-hour run
- [ ] Reload during a scheduled day → alarms rearm correctly with no duplicates
- [ ] Snooze delays exactly 15m and re-alarms
- [ ] Backgrounding for 30 min then returning → missed alarms surface immediately, not silently swallowed

---

# Sprint 9 — Web Push & Missed-Dose Escalation — 🎯 **M3**

**Goal:** Doses alarm even when the app is closed, and unacknowledged doses escalate to every caregiver.

### Scope — in
- VAPID keys, push subscription management, per-device registration
- **Durable Object Alarms as the scheduled job engine**: each household's DO (from Sprint 7) sets an alarm for its next dose event and fires the push when it wakes — no Redis, no separate queue service. (Server runs the same schedule-expansion logic as the client — extracted to a shared package so client and server can't diverge.)
- Service worker push handler with **lock-screen action buttons** ("Taken", "Snooze") that write through to the API
- Escalation: unacknowledged after 15 min → the DO sets a follow-up alarm → high-priority push to all linked caregiver devices
- Low-stock push (deferred from Sprint 5)
- Push reliability instrumentation: delivered vs acknowledged rates per device
- iOS-specific: A2HS requirement, permission prompt UX, documented limitations

### Scope — out
Shabbat suppression (Sprint 10).

### Tasks
1. Extract the schedule engine into a shared package consumed by both client and server
2. VAPID + subscription lifecycle (incl. expiry and re-subscription)
3. DO Alarm scheduling, cancellation on schedule edit, re-scheduling on protocol change
4. SW push handler + notification actions
5. Escalation follow-up alarm + acknowledgement tracking
6. Real-device testing: iOS and Android, screen locked, app force-quit

### Acceptance criteria
- [ ] Push arrives with the app force-quit on both iOS (A2HS) and Android
- [ ] Lock-screen "Taken" logs the dose and syncs — without opening the app
- [ ] Editing a schedule cancels and reschedules the correct future pushes
- [ ] Escalation fires at 15 min and stops immediately on acknowledgement from any device
- [ ] No duplicate alarms when local engine and push both fire (dedupe by occurrence ID)

### Your review checkpoint (~3.5 hrs)
Test with phones genuinely locked overnight. Push reliability is the difference between a useful app and a dangerous one.

---

# Sprint 10 — Zmanim Engine & Shabbat State Machine

**Goal:** The app knows, correctly and automatically, when Shabbat and Yom Tov begin and end, and changes its behavior accordingly.

### Scope — in
- `@hebcal/core` integration, computed **locally on-device** (no network dependency at candle-lighting time)
- Candle lighting = sunset − configurable offset (default 18 min); Havdalah by degrees or minutes per `ShabbatConfig`
- **Yom Tov handling including multi-day chagim and Yom Tov adjacent to Shabbat** (three-day sequences — the PRD says "Yom Tov" but this case needs explicit handling)
- Shabbat state machine: `weekday → pre_shabbat_arming → shabbat_active → motzei_pending → weekday`
- Behavior changes on entry: escalation pushes suppressed, server jobs paused, Shabbat sound alerts armed
- `ShabbatConfig` UI: location, offsets, havdalah method, sound duration
- **Zmanim verification screen**: shows the next 8 weeks of computed times so you can check them against your local luach before trusting it

### Scope — out
Sound alert engine (Sprint 11). Reconciliation UI (Sprint 12).

### Tasks
1. Hebcal integration + local computation
2. Yom Tov and three-day sequence logic
3. State machine with persisted state and correct recovery after reload
4. Escalation suppression + server job pausing
5. Config UI + zmanim verification screen
6. Tests: DST weeks, high-latitude edge cases, chag adjacent to Shabbat, state recovery mid-Shabbat

### Acceptance criteria
- [ ] Computed times match your local luach for the next 8 weeks — **you verify this personally**
- [ ] Mode activates and deactivates automatically at the right moments
- [ ] Three-day chag sequences handled correctly
- [ ] Escalation pushes provably suppressed during Shabbat
- [ ] Reloading the app mid-Shabbat recovers the correct state

### Your review checkpoint (~2.5 hrs)
Check the zmanim against your luach line by line. Wrong by 18 minutes is a real problem.

---

# Sprint 11 — Shabbat Sound Alert Engine

**Goal:** At every Shabbat/Yom Tov dose time, a sound alert fires on caregiver phones, auto-stops after a few seconds, and never repeats or escalates. No screen-on requirement in this sprint — that's Phase 2.

**Builds directly on Sprint 9's push infrastructure** — this is mostly configuration and rigorous testing, not new plumbing.

### Scope — in
- Server schedules a push (existing Durable Object Alarm engine from Sprint 9) for every Shabbat-mode occurrence, tagged so it's handled distinctly from a normal reminder
- **Custom notification sound** on the Android notification channel — distinct, attention-getting, short
- Auto-stop is inherent to OS notification sound playback — verify actual on-device duration matches expectations rather than building a custom stop mechanism
- **Hard suppression of retry/escalation** for Shabbat-tagged pushes specifically — confirm the Sprint 9 escalation job explicitly skips these under test, not just by code inspection (this is the "doesn't come back on" requirement)
- Notification channel importance set to bypass batching where the OS allows it (Android high-priority / time-sensitive category)
- **Do Not Disturb / Focus mode setup checklist**: an in-app screen instructing caregivers to exempt the app from silent mode overnight — a real residual gap the app can't force shut (risk register R2)
- Shabbat-mode doses still written as `status: 'pending_shabbat'` for Sprint 12

### Scope — out
Screen-on / visual kiosk display (Phase 2). Motzei reconciliation (Sprint 12).

### Tasks
1. Tag Shabbat-mode pushes distinctly from normal reminders
2. Wire custom notification sound + channel priority
3. Prove escalation suppression under test, not just by reading the code
4. Build the Do Not Disturb setup checklist screen
5. **Full 25-hour dry run**, phone locked and screen off throughout — the real deliverable of this sprint

### Acceptance criteria
- [ ] 25-hour run with the phone locked and screen off: every alarm sound fires, every one auto-stops, none repeats
- [ ] Zero touches required across the entire run
- [ ] Escalation job verifiably does not fire during the Shabbat window
- [ ] Do Not Disturb checklist is clear enough that you don't need to explain it out loud
- [ ] Same 25-hour run repeated on an iPhone if you have access to one — document any reliability gap honestly (R2/R3)

### Your review checkpoint (~3 hrs, mostly passive)
Run the 25-hour test on a weekday first, ideally on both Android and iPhone. Do not let the first real test be an actual Shabbat.

---

# Sprint 12 — Motzei Shabbat Reconciliation — 🎯 **M4**

**Goal:** After Havdalah, logging everything that happened over Shabbat takes under a minute.

### Scope — in
- Automatic trigger at Havdalah: reconciliation sheet opens on next app interaction
- Lists all `pending_shabbat` occurrences chronologically with medicine, dose, scheduled time
- **Single-tap "confirm all taken"**, plus per-item override to skipped/missed/different-time/different-quantity
- Quick-add for PRN doses given over Shabbat, with retroactive time entry
- Retroactive inventory reconciliation on confirmation
- Multi-caregiver handling: if Mom reconciles first, Dad sees it already done — no double-logging
- Reconciliation is itself an audited event (`reconciledAt`, `reconciledBy`)
- Nothing is auto-confirmed — unreconciled items stay pending and visibly nag

### Tasks
1. Trigger + sheet UI
2. Bulk confirm + per-item override
3. Retroactive PRN entry
4. Inventory reconciliation
5. Multi-caregiver race handling
6. End-to-end test: full simulated Shabbat → reconcile → verify logs and stock

### Acceptance criteria
- [ ] Full Shabbat of doses reconciled in under 60 seconds
- [ ] Per-item corrections work and are audited
- [ ] Inventory correct after reconciliation
- [ ] Two caregivers opening the sheet simultaneously cannot double-log
- [ ] Unreconciled doses remain visible until handled

---

# Sprint 13 — Hardening, Backup & Real-World Soak — 🎯 **M5**

**Goal:** Make it trustworthy enough to depend on.

### Scope — in
- **Full data export/import** (JSON + CSV) and a documented restore path
- Automated server-side backups with a **tested restore** (an untested backup is not a backup)
- Error reporting (Sentry or similar) with PHI scrubbed
- Offline-to-online soak test: 72 hours, mixed device states
- Accessibility pass: font scaling, contrast, screen-reader labels on safety-critical controls
- Onboarding flow for a new caregiver (someone should be able to join and use it without you explaining)
- Empty states, error states, loading states
- Performance: 12 months of logs loaded — Today view still fast
- `/docs/runbook.md`: what to do when sync breaks, push stops, or Shabbat sound alerts don't arrive
- Printable emergency fallback sheet (current protocol on paper, for hospital visits)

### Acceptance criteria
- [ ] Export → wipe → import restores complete state
- [ ] Server restore from backup verified end to end
- [ ] 72-hour soak with no data loss and no unhandled errors
- [ ] A new caregiver onboards unaided in under 5 minutes
- [ ] Today view loads in < 500ms with 12 months of data

---

## 4. Post-v1 backlog (parked)

Not in the 14 weeks; captured so they don't creep in:

- Child/patient-facing role and UI
- Multi-patient switching UI
- Photo attachments on logs (pill identification)
- Symptom and side-effect tracking alongside doses
- Doctor/clinic report generation
- ~~Native wrapper~~ — formalized as **Phase 2** (§1, §3): native Android app for Shabbat screen-on + optional exact alarms app-wide
- Medication interaction warnings — **deliberately excluded**; this crosses from "recorder" into "clinical advice"
- Barcode scanning for inventory refills
- Apple Health / Google Fit integration
- Multi-language (Hebrew) + RTL

---

## 5. Consolidated risk register

| # | Risk | Impact | Likelihood | Mitigation | Sprint |
|---|---|---|---|---|---|
| R1 | Screen-on for Shabbat not achievable on the web platform | Medium (was High) | **Confirmed, deferred by design** | Descoped from v1; solved properly by Phase 2's native app (full-screen intent) | Phase 2 |
| R2 | OS Do Not Disturb / silent mode suppresses the Shabbat push sound | High | Medium | Setup checklist instructing caregivers to exempt the app; residual gap until Phase 2's full-screen intent bypasses it | S11 |
| R3 | iOS push unreliable, incl. for Shabbat sound | High | Medium | Probed in S0; tested explicitly on iOS in S11; Android remains the more dependable path meanwhile | S0, S9, S11 |
| R4 | Device clock skew allows an early dose | **Critical** | Low | Server time sync; fail closed to RED | S4, S7 |
| R5 | Sync conflict loses an intake log | **Critical** | Low | Append-only + client UUIDs + idempotent writes | S7 |
| R6 | Inventory LWW loses concurrent decrements | Medium | High | Delta-stream sync instead of LWW | S7 |
| R7 | Zmanim computed incorrectly | High | Low | 8-week verification against your luach | S10 |
| R8 | IndexedDB evicted by the OS | High | Low | `storage.persist()` + server as source of truth + export | S1, S13 |
| R9 | Your available hours drop (life happens) | Medium | **High** | M1 at week 6 means the app is already useful if everything after stalls | — |
| R10 | Scope creep from a real clinical need mid-build | Medium | High | Park it in the backlog; only safety issues interrupt a sprint | — |

---

## 6. Working agreement

- **Sprint kickoff (Monday, ~30 min):** I state the sprint goal and the open questions; you answer them.
- **Mid-week (Wednesday, ~1 hr):** I ship a partial build; you look and redirect.
- **Sprint close (Friday/Sunday, ~3 hrs):** you review the diff, test on real devices, sign off or reject.
- **Carryover is honest.** Unfinished work moves to the next sprint and displaces something. Nothing is quietly declared done.
- **One exception to sprint boundaries:** a safety bug (R4, R5, or anything letting a dose be given early or lost) interrupts whatever is in flight.
- **Decisions get written down.** `/docs/decisions.md` for technical, `/docs/halachic-decisions.md` for halachic. In four months neither of us will remember why.

---

## 7. What I need from you before Sprint 0 ends

1. **D1–D9 answered** (§2)
2. **D2–D4 confirmed** — Hono + D1 + Durable Objects on Cloudflare (§2); flag now if you'd rather not go all-in on Cloudflare-native
3. **Capability probe run** on your phone and spouse's phone — no dedicated kiosk device needed for v1
4. **Halachic questions sent to your rav** (§1) — answers needed before Sprint 10, so there's slack, but the lead time is out of your control
5. **A real medication protocol** to use as the test fixture from Sprint 2 onward — realistic data finds bugs that synthetic data hides
