import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_CANDLE_LIGHTING_OFFSET_MINS,
  DEFAULT_HAVDALAH,
  DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
  DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
  MAX_CHIME_DURATION_SECONDS,
  MIN_CHIME_DURATION_SECONDS,
  SINGLE_PATIENT_ID,
  describeShabbatWindow,
  shabbatPhaseAt,
  upcomingWindows,
} from '@medguard/shared';
import type { ShabbatConfig } from '@medguard/shared';
import {
  useClock,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import {
  Card,
  buttonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '../../ui/primitives.js';

/**
 * Shabbat & Yom Tov (Sprint A5): what the household's times are, and the check that they are
 * right.
 *
 * Two halves, and the second is the important one. The form sets coordinates and customs; the
 * list below it shows the next eight weeks of candle lighting and Havdalah **as the server
 * computed them**, so they can be compared against a luach before anyone relies on them. That
 * comparison is the sprint's exit gate: a wrong window is silent — the app simply goes quiet at
 * the wrong time, or writes a record it should not have — so it is not something to discover on
 * an actual Shabbat.
 *
 * The windows are read-only here. They are computed in the Worker with `@hebcal/core` and synced
 * down like any other record; this device cannot write one, and the sync API rejects the attempt.
 */

/** Eight weeks, per the sprint plan's verification requirement. */
const WEEKS_SHOWN = 8;

export function ShabbatScreen() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const householdSettings = useHouseholdSettings();

  // `?? null` matters: `useLiveQuery` returns `undefined` until the query first resolves, and the
  // query itself would return `undefined` for "no row" — making "not read yet" and "no config"
  // indistinguishable at every call site below. Collapsing the empty case to `null` keeps
  // `undefined` meaning exactly one thing: still loading.
  const config = useLiveQuery(async () => (await db.shabbatConfig.toArray())[0] ?? null, [db]);
  const windows = useLiveQuery(() => db.shabbatWindows.toArray(), [db]);

  const [draft, setDraft] = useState<ShabbatConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form edits a draft rather than the stored record, so a half-typed latitude is never
  // written — and never syncs to the other caregiver's phone mid-keystroke.
  useEffect(() => {
    if (config && draft === null) {
      setDraft(config);
    }
  }, [config, draft]);

  const nowMs = clock.nowMs();
  const timeZone = householdSettings?.timeZone;

  const phase = useMemo(
    () => shabbatPhaseAt({ config: config ?? undefined, windows: windows ?? [], atMs: nowMs }),
    [config, windows, nowMs],
  );

  const upcoming = useMemo(
    () => upcomingWindows(windows ?? [], nowMs, WEEKS_SHOWN),
    [windows, nowMs],
  );

  const startEditing = () => {
    setDraft(
      config ?? {
        id: ids.next(),
        patientId: SINGLE_PATIENT_ID,
        // Off by default: automation that started silently changing how alarms behave, before
        // anyone had checked the times against a luach, would be exactly backwards.
        autoShabbatEnabled: false,
        latitude: 31.7683,
        longitude: 35.2137,
        candleLightingOffsetMins: DEFAULT_CANDLE_LIGHTING_OFFSET_MINS,
        havdalahDegreesOrMins: DEFAULT_HAVDALAH,
        israelHolidays: true,
        chimeDurationSeconds: DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
        weekdayChimeDurationSeconds: DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
        // Replaced by the repository's own stamp; placeholders satisfy the type.
        updatedAt: '',
        updatedByDeviceId: '',
        syncStatus: 'pending',
      },
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await repository.saveShabbatConfig(draft, config ? 'UPDATE' : 'CREATE');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // Only the published-times half waits on `windows`. The settings form does not depend on them
  // at all, and gating the whole screen on an IndexedDB read meant the screen — its heading
  // included — simply did not exist until that read landed. On a loaded machine that read is slow
  // enough to be a real wait, which is what made the Shabbat-tab e2e assertion flaky: it had been
  // given a longer and longer timeout when what it was waiting for was never the heading.
  const windowsLoading = windows === undefined;
  const configLoading = config === undefined;

  return (
    <div className="flex flex-col gap-3">
      {phase === 'shabbat_active' && (
        <Card className="border-l-4 border-capped">
          <p className="text-sm font-medium">Shabbat mode is on.</p>
          <p className="text-sm text-slate-400">
            Dose alerts chime and stop on their own. Nothing on a notification can be tapped, and
            nothing is being recorded — what happened is logged after Havdalah.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-semibold">Shabbat &amp; Yom Tov</h2>

        {/*
          `config === undefined` is "not read yet", `null`/absent after the read is "genuinely not
          configured" — and the two must not look alike here. Announcing "Not set up" to a
          household that *is* set up, for as long as an IndexedDB read takes, would be a false
          statement about whether Shabbat alarms are working at all.
        */}
        {configLoading && !draft && <p className="text-sm text-slate-400">Loading…</p>}

        {!configLoading && !config && !draft && (
          <>
            <p className="text-sm text-slate-400">
              Not set up. Until this household has coordinates, no Shabbat times are computed and
              alarms behave the same every day of the week.
            </p>
            <button type="button" className={primaryButtonClass} onClick={startEditing}>
              Set up
            </button>
          </>
        )}

        {draft && (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.autoShabbatEnabled}
                onChange={(event) =>
                  setDraft({ ...draft, autoShabbatEnabled: event.target.checked })
                }
              />
              Switch to Shabbat behaviour automatically
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}>
                Latitude
                <input
                  className={inputClass}
                  type="number"
                  step="0.0001"
                  value={draft.latitude}
                  onChange={(event) => setDraft({ ...draft, latitude: Number(event.target.value) })}
                />
              </label>
              <label className={labelClass}>
                Longitude
                <input
                  className={inputClass}
                  type="number"
                  step="0.0001"
                  value={draft.longitude}
                  onChange={(event) =>
                    setDraft({ ...draft, longitude: Number(event.target.value) })
                  }
                />
              </label>
            </div>

            <label className={labelClass}>
              Candle lighting, minutes before sunset
              <input
                className={inputClass}
                type="number"
                min={0}
                max={120}
                value={draft.candleLightingOffsetMins}
                onChange={(event) =>
                  setDraft({ ...draft, candleLightingOffsetMins: Number(event.target.value) })
                }
              />
              <span className="text-xs text-slate-400">
                18 is the widespread custom; Jerusalem is 40 and Haifa 30. Use whatever your
                community follows — the list below will show the result.
              </span>
            </label>

            <label className={labelClass}>
              Havdalah
              <input
                className={inputClass}
                value={draft.havdalahDegreesOrMins}
                onChange={(event) =>
                  setDraft({ ...draft, havdalahDegreesOrMins: event.target.value })
                }
                placeholder="8.5_degrees"
              />
              <span className="text-xs text-slate-400">
                Either a solar depression such as <code>8.5_degrees</code>, or a fixed offset such
                as <code>50_mins</code>.
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.israelHolidays}
                onChange={(event) => setDraft({ ...draft, israelHolidays: event.target.checked })}
              />
              In Israel (one day of Yom Tov rather than two)
            </label>

            {/*
              Two lengths, together, because the difference between them is the point. A weekday
              alert can be acted on — marked, or silenced with a button — so its timeout is the
              backstop for nobody reaching the phone. A Shabbat alert can only be listened to, so
              it says what it has to say and stops.
            */}
            <label className={labelClass}>
              Weekday alert length, seconds
              <input
                className={inputClass}
                type="number"
                min={MIN_CHIME_DURATION_SECONDS}
                max={MAX_CHIME_DURATION_SECONDS}
                value={draft.weekdayChimeDurationSeconds ?? DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS}
                onChange={(event) =>
                  setDraft({ ...draft, weekdayChimeDurationSeconds: Number(event.target.value) })
                }
              />
            </label>
            <span className="-mt-2 text-xs text-slate-400">
              Default {DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS}. Stops early when the dose is marked,
              or when a button on the phone is pressed.
            </span>

            <label className={labelClass}>
              Shabbat alert length, seconds
              <input
                className={inputClass}
                type="number"
                min={MIN_CHIME_DURATION_SECONDS}
                max={MAX_CHIME_DURATION_SECONDS}
                value={draft.chimeDurationSeconds}
                onChange={(event) =>
                  setDraft({ ...draft, chimeDurationSeconds: Number(event.target.value) })
                }
              />
            </label>
            <span className="-mt-2 text-xs text-slate-400">
              Default {DEFAULT_SHABBAT_CHIME_DURATION_SECONDS}. Nothing can be tapped on Shabbat, so
              this alert only stops on its own.
            </span>

            {error && <p className="text-sm text-locked">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {config && (
                <button type="button" className={buttonClass} onClick={() => setDraft(config)}>
                  Reset
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="text-sm font-semibold">The next {WEEKS_SHOWN} times</h3>
        <p className="text-sm text-slate-400">
          Computed by the server from the settings above, and shown in the household&rsquo;s
          timezone. Check these against your luach before relying on them.
        </p>

        {windowsLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="text-sm text-slate-400">
            {config
              ? 'No times published yet — they arrive with the next sync.'
              : 'No times yet. Set the coordinates above and they will be computed.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map((window) => {
              const display = describeShabbatWindow(window, timeZone ?? 'UTC');
              return (
                <li
                  key={window.id}
                  className="flex flex-col gap-1 rounded-md border border-slate-800 p-3 text-sm"
                >
                  <p className="font-medium">{display.label}</p>
                  <p className="text-slate-400">
                    {display.startDate} · {display.startTime} → {display.endDate} ·{' '}
                    {display.endTime}
                  </p>
                  {display.multiDay && (
                    <p className="text-xs text-slate-500">
                      One continuous period — alerts stay in Shabbat mode throughout.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
