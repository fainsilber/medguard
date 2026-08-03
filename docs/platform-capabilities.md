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

The original 3-push burst landed **exactly 15.000 seconds apart**, back to back, with no measurable drift. The Durable Object alarm chain that drives this is precise — this held up again after retuning to a denser burst (see below), where the individual push *timings* stayed exact even though the phone stopped showing every one of them (that was an OS notification-display limit, not a scheduling problem — see "Burst density" below).

### Background JS timers: unreliable, as expected

A plain `setInterval` running in the tab, phone locked for ~75 seconds, produced wildly irregular gaps: several 10–20 second gaps and one **54.5-second** gap against a 5-second expected interval. This is the concrete evidence for why the Shabbat alert design uses server-side push scheduling instead of a timer running inside the page: a locked Android phone suspends JS execution unpredictably, but does not do the same to incoming push.

### Custom notification sound: not supported

A push requesting a custom `sound` field showed `retainedOptions: ["tag", "renotify", "requireInteraction"]` — **`sound` was not retained**. This is direct, on-device confirmation that a Web Push notification cannot carry a custom sound. An earlier draft of the sprint plan (v1.0) assumed it could; this settles that with evidence rather than a guess. Android played its normal default notification sound instead.

### Burst density: tuned four times from direct feedback, not guessed

The Shabbat alert is a rapid burst of pushes rather than one, because a single push only gives a ~1-2 second system tone — nowhere near long enough to reliably wake someone. How many pushes, and how close together, took four rounds of real testing to land on:

| Pass | Burst | What happened |
| --- | --- | --- |
| Original default | 3 pushes, 15s apart (30s span) | Arrived instantly, each buzz clearly distinct — but felt too sparse: "I could hear it, but I'd rather have more, like 10 in the same 45 sec" |
| Tuning 1 | 10 pushes, 5s apart (45s span) | Better, but still not dense enough per the next round of feedback |
| Tuning 2 | 10 pushes, ~1.67s apart (15s span) | "the frequency was better but I think the same 10 but in 15 second would be better" — merged to `main` |
| Tuning 3 | 10 pushes, ~889ms apart (8s span) | **Too tight.** Never merged past the `sprint-1` branch. On-device: "the alerts are so close to one another that the OS prevents some and I didn't hear 10 chimes" — Android's notification system started coalescing or dropping some of the ten rather than showing every one |
| Tuning 4 (current) | 10 pushes, ~1.11s apart (10s span) | Backed off from pass 3 to give the OS enough room to show all ten. Not yet re-confirmed on-device — do that before treating this as settled |

Current values live in `packages/shared/src/push.ts` (`SHABBAT_BURST_COUNT`, `SHABBAT_BURST_SPACING_MS`), with the same tuning history recorded in that file's comments.

**Open question this raises:** somewhere between ~889ms and ~1.67s apart, Android's notification system stops reliably showing every push in the burst. The exact threshold hasn't been isolated — pass 4 is a reasonable step back, not a measured boundary. Worth narrowing down if the burst ever needs to get denser again (e.g. to fit a shorter total window).

---

## iOS — confirmed working (iOS 18)

Tested 2026-08-03. **Push delivery works as expected once the PWA is installed to the home screen.** This closes what was flagged as the biggest open gap from the initial Sprint 0 pass.

What's confirmed: push notifications are delivered to a real iPhone running iOS 18, after installing the app via Add to Home Screen, matching the requirement Safari imposes (iOS refuses Web Push from an ordinary browser tab — the PWA must be installed first).

What's **not** yet captured at the same level of detail as the Android results above: exact delivery latency numbers, whether the current burst spacing (10 pushes / ~1.11s apart) reads as clearly separate alerts on iOS the way it does on Android, and whether iOS's own notification-coalescing behavior kicks in at a different threshold than Android's did in tuning pass 3. iOS is known to have its own limits here (no custom vibration control, no Time Sensitive interruption level for web push, delivery can lag under Focus or Low Power Mode) that haven't been individually verified yet. Worth a full probe run captured the same way as the Android one, to get comparable numbers rather than a verbal "it worked."

---

## Storage persistence — not yet tested

`navigator.storage.persist()` was never actually exercised during the Android run (the button wasn't pressed). Low priority — doesn't block Sprint 1 or Sprint 2 — but worth a quick pass before too much local data accumulates in a real household's use of the app.

---

## Infrastructure findings that shaped the harness itself

Not platform-capability findings in the "what can the browser do" sense, but real problems Sprint 0 surfaced and fixed, worth keeping visible:

- **`npm`'s optional-dependency pruning bug** (npm/cli#4828) repeatedly broke the lockfile across platforms until `lightningcss`'s full platform set was pinned as direct optional dependencies at the exact version `lightningcss` itself requires.
- **Every WebCrypto Web Push library on npm implements only the legacy `aesgcm` scheme**, which Apple's APNs rejects outright. RFC 8291 `aes128gcm` is hand-implemented in `apps/api/src/push/encrypt.ts` and verified byte-for-byte against the RFC's own worked example. Given the iOS push confirmation above, this is now doing real work rather than being a theoretical concern.
- **Cloudflare's Git integration silently disconnected** after working correctly for the first deploy, which stopped auto-deploys on merge with no visible error anywhere. Fixed by reconnecting, and mitigated going forward by a build/deploy version stamp in the app header (`apps/web/src/version.ts`) — if the commit shown on a phone doesn't match the latest merge to `main`, the deploy didn't happen.
