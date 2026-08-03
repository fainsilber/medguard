# Data Handling

What MedGuard stores, where it lives, and who can reach it.

This app holds a child's medication history — what drug, what dose, at what time, given by whom.
That is protected health information in most jurisdictions and sensitive family information in all
of them. This document exists so the handling is a deliberate, reviewable decision rather than
whatever fell out of the implementation.

**Status:** accurate as of Sprint 3 (2026-08-03). Real-time sync and push arrive in Sprints 4–5 and
will extend, not replace, what is described here.

---

## What is stored

### On the device (IndexedDB, via Dexie)

The complete local record: medicines, schedules, intake logs, the inventory ledger, household
settings. This is the primary copy — the app is local-first and fully usable with no network.

Also in `localStorage`, deliberately kept small and non-medical:

| Key | Contents | Why it isn't in IndexedDB |
| --- | --- | --- |
| `medguard-device-id` | A random UUID for this device | Needed synchronously on first paint |
| `medguard-caregiver-name` | The name attached to logs, e.g. "Mom" | Same |
| `medguard-household-session` | Device token, household id, user id | Same; needed before any request |
| `medguard-api-base-url` | Dev-only API override | Not user data |

Browser storage is not encrypted at rest by the app. It inherits whatever the device provides —
full-disk encryption on a modern phone with a lock screen. **A shared, unlocked, unencrypted device
is the realistic exposure**, and no application-level measure meaningfully changes that.
`navigator.storage.persist()` is requested on first load so the OS does not evict the database
under storage pressure.

### On the server (Cloudflare D1)

Per household: the same domain records, plus identity.

| Table | Sensitivity |
| --- | --- |
| `medicines`, `schedules`, `intake_logs`, `inventory_*`, `household_settings`, `shabbat_config` | **Medical.** Drug names, doses, times, who administered, override reasons |
| `households`, `users` | Household name and caregiver display names, both free text |
| `devices` | Device token **hash**, push credentials, a truncated user-agent string |
| `join_codes` | Join code **hash**, expiry, redemption state |
| `join_attempts` | Client IP and timestamp, for rate limiting |

Domain records are stored as validated JSON plus indexed columns. Nothing is encrypted at the
application layer beyond what Cloudflare provides for D1 at rest and TLS in transit.

**Not stored anywhere:** no email addresses, no phone numbers, no passwords, no payment details, no
date of birth, no government identifiers. The patient is a row id with no name attached — a
caregiver's own free-text notes are the only place identifying detail could end up, and that is
their choice, not a field the app asks for.

---

## Credentials

Neither credential is ever stored in a form that can be replayed:

- **Join codes** — six digits, SHA-256 hashed, 15-minute expiry, single use enforced by a
  conditional `UPDATE` that two simultaneous redemptions cannot both win, and per-IP rate limiting
  (10 attempts / 10 minutes). Wrong, expired and already-redeemed all return an identical error, so
  a caller cannot learn which codes exist.
- **Device tokens** — 32 bytes of CSPRNG entropy, SHA-256 hashed at rest, transmitted exactly once
  at issue. A device that loses its token must be re-invited; the server genuinely cannot recover
  it.

A plain hash rather than a slow KDF is deliberate: these are high-entropy machine-generated secrets
with no dictionary to defend against, so a KDF would cost latency and buy nothing. What the hash
does buy is that a leaked database backup contains no working credential.

Tokens are bearer credentials with no expiry today. Revocation (a "sign out this device" control)
is not yet built — see gaps below.

---

## Access control

**The household is the boundary.** Every domain row carries `household_id`; every query filters on
it; and the id comes from the authenticated device token, never from the request. There is no field
a caller can change to reach another household's data, because no route reads a household id from
input.

This is the control that matters most — a mistake here leaks a child's medication history to a
stranger — so it is tested as an explicit negative case rather than assumed: cross-household pull,
cross-household bootstrap, and a payload that names someone else's household id all have tests in
`apps/api/tests/sync.test.ts` and `auth.test.ts`.

Within a household there are no roles. Every caregiver sees and can log everything. That is
intentional for a family managing a child's care together, not an oversight.

---

## Data in transit

HTTPS everywhere; the API refuses nothing else in production. CORS reflects the requesting origin
with credentials enabled, which is broad — see gaps.

---

## Retention and deletion

- **Device:** clearing site data or uninstalling removes the local copy entirely.
- **Server:** `households` cascades on delete to users, devices, and every scoped domain table, so
  removing a household leaves no orphaned medical rows. This is tested.
- **Intake logs are never deleted or edited, by design.** A correction appends a superseding entry
  (safety invariant 1). A dosing history that can be quietly rewritten is not a medical record. This
  is a deliberate tension with "right to erasure" — deleting the whole household is the supported
  path, not selective removal of individual doses.
- **`join_attempts` is self-pruning.** It is the only place an IP address is stored, and it exists
  solely to enforce a 10-minute rate-limit window, so rows older than that window are deleted on
  every write rather than accumulating.
- No automatic retention limit or expiry on anything else.

---

## Known gaps

Honest list, in rough priority order. None is a reason not to use the app today; all are worth
closing before it holds a real protocol for a long stretch.

1. **No token revocation.** A lost or stolen phone cannot be cut off — the token stays valid
   indefinitely. Needs a device list with a revoke control, and the middleware to honour it. This is
   the most serious of these.
2. **CORS reflects any origin.** Convenient while the PWA's deployment URL is still moving; should
   become an explicit allowlist before this is treated as production.
3. **No audit log of reads.** Writes are attributable (every log records who and when). Nobody can
   tell who *read* what.
4. **No application-layer encryption at rest**, on device or server. Both rely on platform
   encryption.
5. **Backup/export is manual.** The CSV and printable summary from Sprint 2 are the only export;
   there is no automated backup. Sprint 7 covers this properly.

---

## If you are reviewing this for compliance

MedGuard is a personal tool for one family, not a product handling other people's data, and nothing
here has been assessed against HIPAA, GDPR, or Israeli privacy law. The gaps above are the honest
starting point for that conversation — particularly the append-only intake log, which is a
deliberate safety property that conflicts with selective erasure rights.
