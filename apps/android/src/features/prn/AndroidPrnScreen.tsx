import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import {
  assessDose,
  blockReasonFor,
  formatCountdown,
  formatLocalTime,
  fromIso,
  isDosePermitted,
} from '@medguard/shared';
import type { DoseSafety, IntakeLog, Medicine } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/AndroidAppProvider.js';
import { useClockTrust } from '../../app/useClockTrust.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import {
  M3Badge,
  M3Card,
  m3ButtonDanger,
  m3ButtonPrimary,
  m3InputClass,
} from '../../ui/MaterialComponents.js';
import type { M3BadgeTone } from '../../ui/MaterialComponents.js';

/** A cooldown that expires must unlock the button without the caregiver reloading. */
const REFRESH_INTERVAL_MS = 30_000;

const STATE_TONE: Record<DoseSafety['state'], M3BadgeTone> = {
  safe: 'safe',
  cooldown: 'locked',
  capped: 'capped',
  untrusted_clock: 'locked',
};

const STATE_LABEL: Record<DoseSafety['state'], string> = {
  safe: 'Safe',
  cooldown: 'Locked',
  capped: 'Capped',
  untrusted_clock: 'Clock unverified',
};

export function AndroidPrnScreen() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const clockTrust = useClockTrust();
  const household = useHouseholdSettings();

  const [override, setOverride] = useState<{ medicine: Medicine; safety: DoseSafety } | null>(null);
  const [reason, setReason] = useState('');

  useTick(REFRESH_INTERVAL_MS);

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  // `asNeeded` is an explicit clinical property, not something inferred from whether guards
  // happen to be configured: a PRN medicine with no cooldown is still a PRN medicine and still
  // belongs on this screen.
  const prnMedicines = (medicines ?? []).filter(
    (medicine) => medicine.asNeeded && !medicine.archived,
  );

  const recordDose = async (medicine: Medicine, safety: DoseSafety, overrideReason?: string) => {
    const blockedBy = blockReasonFor(safety);

    const log: IntakeLog = {
      id: ids.next(),
      patientId: medicine.patientId,
      medicineId: medicine.id,
      type: 'prn',
      status: 'taken',
      actualTime: clock.nowIso(),
      quantityTaken: 1,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
      // Structured, not a note. Safety invariant 5 requires an override to be attributable and
      // machine-readable — a free-text "OVERRIDE: ..." string cannot be counted, audited or
      // shown to a clinician as what the engine actually objected to.
      ...(overrideReason && blockedBy
        ? { override: { confirmedByUserId: userId, reason: overrideReason, blockedBy } }
        : {}),
    };

    await repository.recordDose(log);
    setOverride(null);
    setReason('');
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">As needed (PRN) safety</h2>
        <p className="text-xs text-slate-400">
          Enforces minimum cooldown intervals and the rolling 24-hour dose cap.
        </p>
      </div>

      {override && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-rose-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 animate-pulse rounded-full bg-rose-500" />
              <h3 className="text-lg font-bold text-rose-300">Safety override required</h3>
            </div>
            <p className="text-xs leading-relaxed text-slate-300">
              {override.medicine.name} is blocked ({STATE_LABEL[override.safety.state]}). Recording
              a dose anyway is logged against your name with the reason you give.
            </p>

            <div className="flex flex-col gap-1">
              <label htmlFor="override-reason" className="text-xs font-semibold text-slate-400">
                Override reason
              </label>
              <input
                id="override-reason"
                type="text"
                placeholder="e.g. Doctor instructed by phone"
                className={m3InputClass}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <button
              disabled={!reason.trim()}
              onClick={() => void recordDose(override.medicine, override.safety, reason.trim())}
              className={m3ButtonDanger}
            >
              Confirm override
            </button>

            <button
              onClick={() => {
                setOverride(null);
                setReason('');
              }}
              className="mt-1 text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {prnMedicines.length === 0 ? (
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">
            No as-needed medicines configured.
          </p>
        </M3Card>
      ) : (
        prnMedicines.map((medicine) => {
          const safety = assessDose({
            medicine,
            logs: logs ?? [],
            clock,
            clockTrust,
          });
          const permitted = isDosePermitted(safety);

          return (
            <M3Card key={medicine.id} className="border-l-4 border-l-slate-700">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-slate-100">{medicine.name}</span>
                    <span className="text-xs text-slate-400">
                      {medicine.strength} • Min gap: {medicine.minHoursBetweenDoses ?? '—'}h • Max
                      24h: {medicine.maxDailyDoses ?? 'unlimited'}
                    </span>
                  </div>
                  <M3Badge tone={STATE_TONE[safety.state]}>{STATE_LABEL[safety.state]}</M3Badge>
                </div>

                {safety.state === 'cooldown' && (
                  <div className="rounded-xl border border-rose-800/40 bg-rose-950/40 p-3 text-xs text-rose-300">
                    Locked for {formatCountdown(safety.msRemaining)} — next dose at{' '}
                    <span className="font-bold">
                      {household
                        ? formatLocalTime(household.timeZone, fromIso(safety.availableAtIso))
                        : safety.availableAtIso}
                    </span>
                  </div>
                )}

                {safety.state === 'capped' && (
                  <div className="rounded-xl border border-amber-800/40 bg-amber-950/40 p-3 text-xs text-amber-300">
                    {safety.dosesInWindow} of {safety.maxDailyDoses} doses used in the last 24
                    hours. Next dose in {formatCountdown(safety.msRemaining)}.
                  </div>
                )}

                {safety.state === 'untrusted_clock' && (
                  <div className="rounded-xl border border-rose-800/40 bg-rose-950/40 p-3 text-xs text-rose-300">
                    This device&rsquo;s clock cannot be verified, so a cooldown cannot be proven to
                    have elapsed. Guarded medicines stay blocked until it can.
                  </div>
                )}

                <div className="mt-1 flex items-center justify-between">
                  {permitted ? (
                    <button
                      onClick={() => void recordDose(medicine, safety)}
                      className={m3ButtonPrimary}
                    >
                      Give PRN dose
                    </button>
                  ) : (
                    <button
                      onClick={() => setOverride({ medicine, safety })}
                      className={m3ButtonDanger}
                    >
                      Override safety lock
                    </button>
                  )}
                </div>
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
