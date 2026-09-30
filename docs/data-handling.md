# Data Handling

What MedGuard stores, where it lives, and who can reach it.

This app holds a child's medication history — what drug, what dose, at what time, given by whom.
That is protected health information in most jurisdictions and sensitive family information in all
of them. This document exists so the handling is a deliberate, reviewable decision rather than
whatever fell out of the implementation.

**Status:** updated 2026-09-30 to add the public privacy policy (below) and to record that household
deletion now also purges Durable Object storage; the sprint status that follows is as of 2026-08-09.
Real-time sync (Sprint 4) is deployed; the Android client's local
alarm engine (Sprint A3) is code-complete; server-side push and the dose-alarm/escalation chain
(Sprint 5, driven by the Android track as Sprint A4) are still unbuilt. The Android section below
describes device-local storage on a real, code-complete client (Sprints A0–A3), not a scaffold.

---

## What is stored

### On the device (IndexedDB, via Dexie)

The complete local record: medicines, schedules, intake logs, the inventory ledger, household
settings, and (since Sprint A3) `doseSnoozes` — an append-only record of who deferred which dose,
by how long. This is the primary copy — the app is local-first and fully usable with no network.
The web client stores `doseSnoozes` (so a snooze made on a synced Android device lands somewhere
rather than being dropped) but does not yet write to it; only Android's bounded-snooze UI does.

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

### On the device (Android, `expo-sqlite`)

The same complete local record as the web client's IndexedDB copy — medicines, schedules, intake
logs, the inventory ledger, household settings, `doseSnoozes` — in a SQLite file instead
(`docs/android-client-plan.md`, "Storage and the sync port").

Two additional, Android-only stores exist outside that SQLite file, both alarm bookkeeping rather
than medical history and both covered by the same backup exclusion below (`sharedpref` is an
excluded domain): `medguard_pending_actions` (a captured Taken/Snooze tap, durable from the instant
of the tap until `AlarmEngine` acknowledges it — Sprint A3, `PendingActionStore.kt`) and
`medguard_armed_alarms` (a mirror of which occurrences are currently armed, read back by
`BootReceiver` after a reboot — `ArmedAlarmStore.kt`). Both are Android `SharedPreferences`, not
rows in the SQLite file itself — worth being precise about, since they hold a tap's timestamp and
an occurrence identifier (schedule id + due time), not drug names or doses, but they are still
device-local dosing-adjacent data and still need the same auto-backup exclusion the SQLite file
gets.

Two things the web client doesn't need to worry about, and this one does:

- **`android:allowBackup="false"`, plus explicit `dataExtractionRules` and `fullBackupContent`**
  (`apps/android/plugins/withMedGuardAlarms.ts`). Android's auto-backup would otherwise copy this
  SQLite file — a child's complete dosing history — into the user's Google Drive, silently and by
  default, the first time the OS decides to back the device up. Both the modern
  (`dataExtractionRules`, API 31+) and legacy (`fullBackupContent`) mechanisms exclude the
  `database`, `sharedpref` and `file` domains, since the same failure mode applies to whichever
  one a given OS version actually consults.
- **The device token lives in `expo-secure-store` (Android Keystore-backed), not an equivalent of
  `localStorage`.** A modest improvement over the web client's exposure, and free on this platform.

As on web, this is local-first and fully usable with no network, and inherits the device's
full-disk encryption rather than adding an application-level one — the same "shared, unlocked,
unencrypted device is the realistic exposure" caveat above applies unchanged.

### On the server (Cloudflare D1 and Durable Objects)

Per household: the same domain records, plus identity.

| Table | Sensitivity |
| --- | --- |
| `medicines`, `schedules`, `intake_logs`, `inventory_*`, `household_settings`, `shabbat_config` | **Medical.** Drug names, doses, times, who administered, override reasons |
| `dose_snoozes` (Sprint A3) | **Medical-adjacent.** Who deferred which dose occurrence, by how long, and when — no drug name or quantity of its own, but ties directly to a specific scheduled dose |
| `HouseholdDO` storage (`dose_alarms`, `shabbat_bursts`, `low_stock_flags`, `alarm_meta`) | **Medical.** Not in D1: each household's Durable Object keeps its own SQLite copy of medicine names, patient display names, dose sizes and due times for the alarm chain, plus the household id. D1's `ON DELETE CASCADE` cannot reach it, so `DELETE /households` purges it explicitly (`HouseholdDO.purge`) |
| `households`, `users`, `patients` | Household name, caregiver display names, and (since multi-patient households) a display name for each person whose medicines are tracked — all free text the caregiver chooses. `patients` carries no date of birth or ID number |
| `devices` | Device token **hash**, push credentials, a truncated user-agent string |
| `join_codes` | Join code **hash**, expiry, redemption state |
| `join_attempts` | Client IP and timestamp, for rate limiting |

Domain records are stored as validated JSON plus indexed columns. Nothing is encrypted at the
application layer beyond what Cloudflare provides for D1 at rest and TLS in transit.

**Not stored anywhere:** no email addresses, no phone numbers, no passwords, no payment details, no
date of birth, no government identifiers. Each patient has a caregiver-chosen display name
(`patients.display_name`, up to 200 characters — a first name, nickname or initial is enough; the
app does not ask for a surname, date of birth or ID). Free-text notes are the only other place
identifying detail could end up, and that is the caregiver's choice, not a field the app asks for.

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

- **Push credentials** (Sprint A4) — a Web Push subscription (endpoint plus its two public keys) or
  an FCM registration token, stored in plaintext on the device's own `devices` row
  (`push_credentials`). Plaintext because they are addresses, not secrets: the server has to *use*
  them to send, so a hash would make them useless. They are still worth treating carefully — an
  endpoint identifies a browser installation, and a leaked one lets a third party send that device
  notifications (they cannot read anything, and on the Web Push path they cannot decrypt a payload
  either, which needs the subscription's private key that never leaves the browser). Registration is
  authenticated and scoped to the calling device: `POST /api/v1/devices/push` writes only the row
  the bearer token resolves to. A dead credential is cleared, not deleted along with the device —
  the row is the caregiver's login, and a rotated browser subscription must not sign anyone out.

A plain hash rather than a slow KDF is deliberate: these are high-entropy machine-generated secrets
with no dictionary to defend against, so a KDF would cost latency and buy nothing. What the hash
does buy is that a leaked database backup contains no working credential.

Tokens are bearer credentials with no expiry today, but revocation exists: `HouseholdScreen`'s
device list can revoke another device, which deletes its `devices` row outright
(`deviceRoutes.delete('/:deviceId')`, `apps/api/src/routes/devices.ts`) rather than merely marking
it inactive, since the token itself is the only credential — leaving it live anywhere is a live
credential to a child's medical record. The server side has no way to *tell* the revoked device
this happened, though, which is its own gap — see "Revoked-device data retention" in
`apps/android/README.md`: the revoked device's local copy of the medical data stays on it until the
next failed sync round surfaces a `'revoked'` status and the caregiver takes the explicit two-step
"Clear local data" action. Self-revocation (a device removing itself, e.g. "sign out this device")
is not a separate flow — the same delete route serves both.

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
- **Server:** any caregiver can delete their household in-app (Household screen → "Delete this
  household", `DELETE /api/v1/households`). `households` cascades on delete to users, devices, and
  every scoped domain table, and the route then purges the household's Durable Object storage,
  which the cascade cannot reach (it holds medicine names and dose sizes — see the server table
  above). Both halves are tested (`household-lifecycle.test.ts`, `alarms.test.ts`). Copies already
  synced to other caregivers' devices stay on those devices until cleared there.
- **Intake logs are never deleted or edited, by design.** A correction appends a superseding entry
  (safety invariant 1). A dosing history that can be quietly rewritten is not a medical record. This
  is a deliberate tension with "right to erasure" — deleting the whole household is the supported
  path, not selective removal of individual doses.
- **`join_attempts` is self-pruning.** It is the only place an IP address is stored, and it exists
  solely to enforce a 10-minute rate-limit window, so rows older than that window are deleted on
  every write rather than accumulating.
- No automatic retention limit or expiry on anything else.

### Known test data in production

One household exists in the production database purely from verifying the Sprint 3 deploy against
the live API (2026-08-03), not from real use:

| Field | Value |
| --- | --- |
| Household name | `Deploy Verification (delete me)` |
| Household id | `8a479c7d-67e7-421d-ab80-06b2c6381d4f` |
| Contents | One caregiver ("Verify"), one device, one medicine named "Verify" |

The API's delete route (§ Retention and deletion, above) needs a signed-in device of that
household, so if none is left, removing it means a direct SQL delete against the production D1
database. That does **not** reach the household's Durable Object storage. This one has a medicine
but no schedule, so at most its household id sits there and no medicine names or dose sizes do; a
household that had schedules should be deleted through the API route instead:

```bash
cd apps/api
npx wrangler d1 execute medguard --remote \
  --command "DELETE FROM households WHERE id = '8a479c7d-67e7-421d-ab80-06b2c6381d4f'"
```

`households` cascades to its user, device, and medicine row on delete, so this one statement is
enough to remove all of it. Left in place for now at the user's request; safe to leave indefinitely
if it's easier than remembering to run this.

---

## Known gaps

Honest list, in rough priority order. None is a reason not to use the app today; all are worth
closing before it holds a real protocol for a long stretch.

1. **A revoked device's local medical data isn't remotely wiped.** Revocation cuts off sync
   immediately, but the revoked device's local copy of medicines, schedules and logs stays on it
   until a caregiver notices the `'revoked'` status and completes the explicit "Clear local data"
   confirm — see "Revoked-device data retention" in `apps/android/README.md`. There is no push-based
   remote wipe. This is the most serious of these.
2. **A dose notification's text reaches the lock screen, and the phone's own notification history.**
   Sprint A4's alerts name the person and the medicine (a caregiver woken at 3 AM by "a dose is due"
   cannot act on it), which means a patient's display name and a medicine name are visible on a
   locked screen and retained in Android's
   notification log until it is cleared. Deliberate, and the same trade every medication reminder
   makes; worth knowing about if a phone is shared or seen by others. Shabbat-mode alerts carry the
   same detail. Nothing else about the record — dosage history, notes, who logged what — ever leaves
   the app.
3. **CORS reflects any origin.** Convenient while the PWA's deployment URL is still moving; should
   become an explicit allowlist before this is treated as production.
4. **No audit log of reads.** Writes are attributable (every log records who and when). Nobody can
   tell who *read* what.
5. **No application-layer encryption at rest**, on device or server. Both rely on platform
   encryption.
6. **Backup/export is manual.** The CSV, printable summary and full JSON backup/import/wipe (Sprint 2
   and Sprint 7, landed early) are the only export path; there is no automated/scheduled backup.

---

## The public privacy policy

Google Play requires a privacy policy on the store listing and inside the app, on a public,
login-free, non-PDF web page. It is `apps/web/public/privacy.html` — a static, self-contained file
(no scripts, fonts or third-party requests), served by the web Worker at
**https://medguard-web.fainsilber.workers.dev/privacy** (`PRIVACY_POLICY_URL` in
`packages/shared/src/links.ts`). That extension-less path returns 200 directly; `/privacy.html`
redirects to it.

It is linked from the first-run screen, the name screen and (web) a footer on every tab, and
(Android) the Household and Settings screens. The Android app opens the absolute URL; the web app links to its own
precached copy, so it reads offline.

**When this document changes, the policy probably has to.** In particular, edit
`privacy.html` (and its "Last updated" date) whenever any of these change:

- a new kind of data is stored, or an existing one starts being sent somewhere new;
- a new third party handles data (a push provider, analytics, crash reporting — none exist today,
  and the policy says so);
- an Android permission is added to `apps/android/plugins/withMedGuardAlarms.ts`;
- deletion or retention behaviour changes (the policy describes the in-app delete and the ten-minute
  IP window).

`apps/web/tests/privacyPolicy.test.ts` pins the policy's shape (self-contained; names Cloudflare,
FCM and web push; has a deletion section and a contact) but cannot check that the prose is true.
The Play Console **Data safety** form and the store listing's privacy-policy URL are entered by
hand and must agree with it.

---

## If you are reviewing this for compliance

MedGuard is a personal tool for one family, not a product handling other people's data, and nothing
here has been assessed against HIPAA, GDPR, or Israeli privacy law. The gaps above are the honest
starting point for that conversation — particularly the append-only intake log, which is a
deliberate safety property that conflicts with selective erasure rights.
