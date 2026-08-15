import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  DEFAULT_CANDLE_LIGHTING_OFFSET_MINS,
  DEFAULT_HAVDALAH,
  DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
  DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
  SINGLE_PATIENT_ID,
  describeShabbatWindow,
  shabbatPhaseAt,
  upcomingWindows,
} from '@medguard/shared';
import type { ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { useClock, useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Button, Card, KeyboardAvoidingScreen, colors, styles as ui } from '../../ui/primitives.js';

/**
 * RN port of `apps/web/src/features/shabbat/ShabbatScreen.tsx` — the household's Shabbat settings,
 * and the eight weeks of computed times that have to be checked against a luach before anyone
 * relies on them (Sprint A5).
 *
 * Windows are server-authored and read-only here, exactly as on the web: this device holds them
 * so it can arm the right alarms with no network, but it never writes one.
 */

const WEEKS_SHOWN = 8;

interface ShabbatData {
  config: ShabbatConfig | undefined;
  windows: ShabbatWindow[];
}

export function ShabbatScreen(): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const householdSettings = useHouseholdSettings();

  const data = useLiveQuery<ShabbatData>(
    async () => ({
      config: await repository.getShabbatConfig(),
      windows: await repository.allShabbatWindows(),
    }),
    ['shabbatConfig', 'shabbatWindows'],
  );

  const [draft, setDraft] = useState<ShabbatConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.config && draft === null) {
      setDraft(data.config);
    }
  }, [data?.config, draft]);

  const nowMs = clock.nowMs();
  const timeZone = householdSettings?.timeZone ?? 'UTC';

  const phase = useMemo(
    () => shabbatPhaseAt({ config: data?.config, windows: data?.windows ?? [], atMs: nowMs }),
    [data?.config, data?.windows, nowMs],
  );

  const upcoming = useMemo(
    () => upcomingWindows(data?.windows ?? [], nowMs, WEEKS_SHOWN),
    [data?.windows, nowMs],
  );

  if (!data) {
    return (
      <ScrollView contentContainerStyle={ui.content} style={ui.screen}>
        <Card>
          <Text style={ui.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  const startEditing = () => {
    setDraft(
      data.config ?? {
        id: ids.next(),
        patientId: SINGLE_PATIENT_ID,
        // Off until the times below have been checked: automation that quietly changed how alarms
        // behave before anyone had verified it would be exactly backwards.
        autoShabbatEnabled: false,
        latitude: 31.7683,
        longitude: 35.2137,
        candleLightingOffsetMins: DEFAULT_CANDLE_LIGHTING_OFFSET_MINS,
        havdalahDegreesOrMins: DEFAULT_HAVDALAH,
        israelHolidays: true,
        chimeDurationSeconds: DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
        weekdayChimeDurationSeconds: DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
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
      await repository.saveShabbatConfig(draft, data.config ? 'UPDATE' : 'CREATE');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        contentContainerStyle={ui.content}
        style={ui.screen}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={ui.title}>Shabbat &amp; Yom Tov</Text>

        {phase === 'shabbat_active' ? (
          <Card style={{ borderColor: colors.capped }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>Shabbat mode is on.</Text>
            <Text style={ui.subtitle}>
              Dose alerts chime and stop on their own. Nothing on a notification can be tapped, and
              nothing is being recorded — what happened is logged after Havdalah.
            </Text>
          </Card>
        ) : null}

        {!data.config && !draft ? (
          <Card>
            <Text style={ui.subtitle}>
              Not set up. Until this household has coordinates, no Shabbat times are computed and
              alarms behave the same every day of the week.
            </Text>
            <Button label="Set up" variant="primary" onPress={startEditing} />
          </Card>
        ) : null}

        {draft ? (
          <Card>
            <View style={[ui.row, { justifyContent: 'space-between' }]}>
              <Text style={{ color: colors.text, flex: 1 }}>
                Switch to Shabbat behaviour automatically
              </Text>
              <Switch
                value={draft.autoShabbatEnabled}
                onValueChange={(value) => setDraft({ ...draft, autoShabbatEnabled: value })}
                accessibilityLabel="Switch to Shabbat behaviour automatically"
              />
            </View>

            <View>
              <Text style={ui.label}>Latitude</Text>
              <TextInput
                style={ui.input}
                keyboardType="numeric"
                value={String(draft.latitude)}
                onChangeText={(text) => setDraft({ ...draft, latitude: Number(text) })}
                accessibilityLabel="Latitude"
              />
            </View>

            <View>
              <Text style={ui.label}>Longitude</Text>
              <TextInput
                style={ui.input}
                keyboardType="numeric"
                value={String(draft.longitude)}
                onChangeText={(text) => setDraft({ ...draft, longitude: Number(text) })}
                accessibilityLabel="Longitude"
              />
            </View>

            <View>
              <Text style={ui.label}>Candle lighting, minutes before sunset</Text>
              <TextInput
                style={ui.input}
                keyboardType="numeric"
                value={String(draft.candleLightingOffsetMins)}
                onChangeText={(text) =>
                  setDraft({ ...draft, candleLightingOffsetMins: Number(text) })
                }
                accessibilityLabel="Candle lighting, minutes before sunset"
              />
              <Text style={ui.subtitle}>
                18 is the widespread custom; Jerusalem is 40 and Haifa 30. Use whatever your
                community follows — the list below will show the result.
              </Text>
            </View>

            <View>
              <Text style={ui.label}>Havdalah</Text>
              <TextInput
                style={ui.input}
                value={draft.havdalahDegreesOrMins}
                onChangeText={(text) => setDraft({ ...draft, havdalahDegreesOrMins: text })}
                placeholder="8.5_degrees"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Havdalah"
              />
              <Text style={ui.subtitle}>
                Either a solar depression such as 8.5_degrees, or a fixed offset such as 50_mins.
              </Text>
            </View>

            <View style={[ui.row, { justifyContent: 'space-between' }]}>
              <Text style={{ color: colors.text, flex: 1 }}>
                In Israel (one day of Yom Tov rather than two)
              </Text>
              <Switch
                value={draft.israelHolidays}
                onValueChange={(value) => setDraft({ ...draft, israelHolidays: value })}
                accessibilityLabel="In Israel (one day of Yom Tov rather than two)"
              />
            </View>

            {/*
              Two lengths, together, because the difference between them is the point. A weekday
              alert can be acted on — marked, or silenced with a button — so its timeout is the
              backstop for nobody reaching the phone. A Shabbat alert can only be listened to, so
              it says what it has to say and stops.
            */}
            <View>
              <Text style={ui.label}>Weekday alert length, seconds</Text>
              <TextInput
                style={ui.input}
                keyboardType="numeric"
                value={String(
                  draft.weekdayChimeDurationSeconds ?? DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
                )}
                onChangeText={(text) =>
                  setDraft({ ...draft, weekdayChimeDurationSeconds: Number(text) })
                }
                accessibilityLabel="Weekday alert length, seconds"
              />
              <Text style={ui.helpText}>
                Default {DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS}. Stops early when the dose is
                marked, or when a button on the phone is pressed.
              </Text>
            </View>

            <View>
              <Text style={ui.label}>Shabbat alert length, seconds</Text>
              <TextInput
                style={ui.input}
                keyboardType="numeric"
                value={String(draft.chimeDurationSeconds)}
                onChangeText={(text) => setDraft({ ...draft, chimeDurationSeconds: Number(text) })}
                accessibilityLabel="Shabbat alert length, seconds"
              />
              <Text style={ui.helpText}>
                Default {DEFAULT_SHABBAT_CHIME_DURATION_SECONDS}. Nothing can be tapped on Shabbat,
                so this alert only stops on its own.
              </Text>
            </View>

            {error ? <Text style={ui.errorText}>{error}</Text> : null}

            <View style={ui.row}>
              <Button
                label={saving ? 'Saving…' : 'Save'}
                variant="primary"
                disabled={saving}
                onPress={() => void save()}
              />
              {data.config ? (
                <Button label="Reset" onPress={() => setDraft(data.config ?? null)} />
              ) : null}
            </View>
          </Card>
        ) : null}

        <Card>
          <Text style={{ color: colors.text, fontWeight: '600' }}>
            The next {WEEKS_SHOWN} times
          </Text>
          <Text style={ui.subtitle}>
            Computed by the server from the settings above, and shown in the household&rsquo;s
            timezone. Check these against your luach before relying on them.
          </Text>

          {upcoming.length === 0 ? (
            <Text style={ui.subtitle}>
              {data.config
                ? 'No times published yet — they arrive with the next sync.'
                : 'No times yet. Set the coordinates above and they will be computed.'}
            </Text>
          ) : (
            <View style={{ gap: 8 }}>
              {upcoming.map((window) => {
                const display = describeShabbatWindow(window, timeZone);
                return (
                  <View key={window.id} style={{ gap: 2 }}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{display.label}</Text>
                    <Text style={ui.subtitle}>
                      {display.startDate} · {display.startTime} → {display.endDate} ·{' '}
                      {display.endTime}
                    </Text>
                    {display.multiDay ? (
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>
                        One continuous period — alerts stay in Shabbat mode throughout.
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}
