# Halachic Decisions

Answers to the questions in `medguard-sprint-plan.md` § Halachic questions for your rav, recorded here so the reasoning behind Sprint 6's Shabbat design survives independently of the code.

**Status: working decisions, not yet confirmed by a rav.** These were given as pragmatic answers to keep the project moving, not relayed from an actual consultation. Treat Sprint 6 as built against a placeholder ruling until you've actually asked. If/when you get a real answer, update this file — anything that turns out to differ gets revisited before that Shabbat, not silently kept.

---

### 1. Automatic pre-programmed audio on Shabbat/Yom Tov

**Answer: OK.** A phone playing a short, pre-configured audio alert at a scheduled time — triggered by a server push rather than a local timer, everything set before Shabbat begins — is acceptable.

**Design implication:** none. This confirms delta D1 / Sprint 6's chime-burst design as planned.

### 2. Delaying the record of what happened until after Shabbat

**Answer: OK.** Doses given during Shabbat/Yom Tov are not logged until the Motzei Shabbat reconciliation sheet, opened after Havdalah.

**Design implication:** none. Confirms the reconciliation model as planned.

### 3. Escalating an alert if a dose is missed

**Answer: no follow-up escalation during Shabbat/Yom Tov — because the initial alert already reaches every caregiver, not just one.**

This is a design decision, not just a confirmation of silence. The mechanism is: during Shabbat/Yom Tov, the dose-time push burst is sent to **every** caregiver device in the household simultaneously, not to a single primary device with escalation as a fallback. Because everyone already has the alert from the first burst, there is nothing left to escalate to — the escalation step is replaced, not merely suppressed.

**Design implication for Sprint 6:** `HouseholdDO`'s Shabbat-mode push scheduling must fan out to all registered devices in the household on the initial burst, not just one. This differs from standard-mode behavior (Sprint 5), where the initial push may go to fewer devices and escalation to the rest happens only after 15 minutes unacknowledged. The Shabbat suppression logic (delta D5) should be read as "escalation is structurally unnecessary here," not "escalation is a feature we turned off."

### 4. Whether a *grama* mechanism is required

**Answer: No.**

**Design implication:** none.

### 5. Interacting with a notification during a genuine emergency

**Answer: Deferred.** Not being designed for v1.

**Design implication:** Sprint 6 ships with no emergency-interaction affordance. Shabbat pushes stay informational-only with no action buttons (per D5), full stop — there is no "break glass" button. If a caregiver needs to act in a genuine emergency, that happens outside the app entirely (calling for help, physically operating the phone as needed), not through a designed-for path. This is a known, deliberate gap, tracked as backlog rather than blocking Sprint 6.
