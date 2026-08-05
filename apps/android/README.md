# MedGuard Android client

A Capacitor wrapper around a React + Vite build of the MedGuard UI, sharing `packages/shared`
verbatim with the web client so the safety guards, schedule expansion, timezone arithmetic and
inventory ledger have exactly one implementation.

```
npm run dev   --workspace=@medguard/android   # Vite dev server on :3001
npm run build --workspace=@medguard/android   # web assets into dist/
npm test                                      # runs the `android` vitest project with the rest
```

## What this build does and does not do

It is a complete offline client: medicines and schedules, the Today view, PRN cooldown and
rolling-cap enforcement with a full override audit trail, the append-only inventory ledger, and
Motzei Shabbat reconciliation. Every local write is queued in `syncOutbox` in the same
transaction as the change itself.

It does **not** yet:

- **Upload anything.** Nothing drains the outbox — there is no API client here. The Device screen
  shows the queued count and says so plainly rather than implying the household is in sync.
- **Wake a locked phone.** No dose alarms, no escalation, and no 45-second Shabbat chime on a
  locked screen. Those need the native alarm layer (`AlarmManager.setAlarmClock`, a foreground
  service on the alarm stream, versioned notification channels) specified in
  `docs/android-client-plan.md`. The Shabbat screen's chime is a foreground-only approximation
  and is labelled as one.
- **Verify its clock against the server.** Only the local monotonic drift check runs, so a phone
  whose clock was already wrong before launch reads as trusted. `apps/web/src/clock/` has the
  server half.

These gaps are stated in the UI as well as here, because a caregiver relying on an alert that
does not exist is worse off than one who knows to set a separate alarm.

## Generating the native project

`android/` is not a complete Gradle project. It holds only the manifest and resources this app
overrides; Capacitor generates the rest:

```
npm run build --workspace=@medguard/android
npx cap add android --workspace=@medguard/android   # first time only
npm run cap:sync --workspace=@medguard/android      # copies dist/ into the Android project
```

`cap add` writes the Gradle wrapper, `MainActivity`, and a default manifest, then merges the
files already committed here. Commit the generated project afterwards if you want reproducible
builds — Capacitor's model is that `android/` is source, not build output.

Two things the generated project needs by hand:

- `namespace "com.medguard.app"` in `android/app/build.gradle`. AGP 8 removed the manifest's
  `package` attribute, which is why the committed manifest has none.
- Nothing else may re-enable auto-backup. `android:allowBackup="false"` plus
  `res/xml/data_extraction_rules.xml` keep a child's dosing history out of the user's Google
  Drive, which Android would otherwise copy there by default.

## Known duplication

`src/db/repository.ts` is a small subset of `apps/web/src/db/repository.ts` — the same
transaction-plus-outbox pairing, for the four writes these screens make. Cross-cutting rule 5
says this should be one implementation, and `docs/android-client-plan.md` schedules the fix as a
`packages/store` extraction with a conformance suite running against both backends. Until that
lands, every domain object written here is still built by `packages/shared` (`buildDoseAdjustment`,
`buildManualAdjustment`, `assessDose`, `expandSchedules`), so the duplication is the Dexie
transaction wrapper only — not the safety logic.

## Divergence from the client plan

`docs/android-client-plan.md` specifies React Native + Expo, chosen so the native alarm layer can
be written in Kotlin behind a local Expo module. This app is Capacitor + WebView instead. A
WebView cannot deliver the locked-device alarm behaviour that is the plan's stated reason for a
native client at all, so treat this as a working parity client, not as the plan being executed.
