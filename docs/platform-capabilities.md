# Platform Capabilities — Sprint 0 Probe Results

Real-device evidence from the Sprint 0 capability probe (`apps/web/src/probe/`), replacing the platform guesses the Shabbat and alarm design otherwise would have been built on. Raw JSON from each run is preserved in the PR history; this is the readable summary.

---

## Android — tested 2026-08-02

**Device/browser:** Chrome on Android. Environment snapshot:

| Check | Result |
| --- | --- |
| Service Worker supported | ✅ |
| Push Manager supported | ✅ |
| Notifications supported | ✅ |
| Notification permission | granted |
| Installed to home screen | No (not required on Android — push works from an ordinary browser tab) |
| Storage persistence check | Not run — still open |

### Push delivery: fast and reliable

Every test push arrived while the phone was locked, with delivery latency between **214ms and 581ms** — effectively instant, zero drops across five separate sends.

### Server-side scheduling: exact, zero jitter

The original 3-push burst (3×/15s apart) landed **exactly 15.000 seconds apart**, back to back, with no measurable drift. The Durable Object alarm chain that drives this is precise regardless of burst density — confirmed again after retuning (see below).

### Background JS timers: unreliable, as expected

A plain `setInterval` running in the tab, phone locked for ~75 seconds, produced wildly irregular gaps: several 10–20 second gaps and one **54.5-second** gap against a 5-second expected interval. This is the concrete evidence for why the Shabbat alert design (delta D1) uses server-side push scheduling rather than an in-page timer — a locked Android phone suspends JS execution unpredictably, but does not do the same to incoming push.

### Custom notification sound: not supported — settles delta D1

A push requesting a custom `sound` field showed `retainedOptions: ["tag", "renotify", "requireInteraction"]` — **`sound` was not retained**. This is direct, on-device confirmation that a Web Push notification cannot carry a custom sound, contradicting sprint plan v1.0's assumption and confirming the assessment this plan (v2.0) was built on. Android played its normal default notification sound instead.

### Burst density: tuned three times from direct feedback, not guessed

| Pass | Burst | Feedback |
| --- | --- | --- |
| Original default | 3× / 15s apart (30s span) | "I could hear it, but I'd rather have more, like 10 in the same 45 sec" — clearly distinct, felt too sparse |
| Tuning 1 | 10× / 5s apart (45s span) | "the frequency was better but I think the same 10 but in 15 second would be better" |
| Tuning 2 | 10× / ~1.67s apart (15s span) | Merged to `main`. |
| Tuning 3 | 10× / ~889ms apart (8s span) | Requested ahead of Sprint 1 kickoff — **not yet confirmed on-device**. Sitting on the `sprint-1/domain-core-and-local-persistence` branch, not yet in `main`. Confirm this one before treating it as settled the way passes 1 and 2 were — at ~889ms apart, individual pushes risk starting to blur together rather than reading as distinct alerts. |

Current values live in `packages/shared/src/push.ts` (`SHABBAT_BURST_COUNT`, `SHABBAT_BURST_SPACING_MS`), with the same tuning history recorded in that file's comments.

---

## iOS — not yet tested

No iPhone was available during Sprint 0. This is the biggest open gap: iOS has stricter push requirements (home-screen install before push works at all, no custom sound *and* no custom vibration control the way Android has, delivery can lag under Focus/Low Power Mode) documented as assumptions in the sprint plan (delta D1) but not yet verified. Run the same probe on an iPhone before relying on any iOS behavior beyond "best effort."

---

## Storage persistence — not yet tested

`navigator.storage.persist()` was never actually exercised during the Android run (the button wasn't pressed). Low priority — doesn't block Sprint 1 — but worth a quick pass before Sprint 1's Dexie work leans on persistent storage being available.

---

## Infrastructure findings that shaped the harness itself

Not platform-capability findings in the "what can the browser do" sense, but real problems Sprint 0 surfaced and fixed, worth keeping visible:

- **`npm`'s optional-dependency pruning bug** (npm/cli#4828) repeatedly broke the lockfile across platforms until `lightningcss`'s full platform set was pinned as direct optional dependencies at the exact version `lightningcss` itself requires.
- **Every WebCrypto Web Push library on npm implements only the legacy `aesgcm` scheme**, which Apple's APNs rejects outright. RFC 8291 `aes128gcm` is hand-implemented in `apps/api/src/push/encrypt.ts` and verified byte-for-byte against the RFC's own worked example.
- **Cloudflare's Git integration silently disconnected** after working correctly for the first deploy, which stopped auto-deploys on merge with no visible error anywhere. Fixed by reconnecting, and mitigated going forward by a build/deploy version stamp in the app header (`apps/web/src/version.ts`) — if the commit shown on a phone doesn't match the latest merge to `main`, the deploy didn't happen.
