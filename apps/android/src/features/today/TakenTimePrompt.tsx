import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { formatLocalDate, formatLocalTime, fromIso, resolveLocal, toIso } from '@medguard/shared';
import type { EpochMs, IsoInstant } from '@medguard/shared';
import { Button, colors, styles as ui } from '../../ui/primitives.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * RN port of `apps/web/src/features/today/TakenTimePrompt.tsx`. Asks when an overdue dose was
 * *actually* given rather than assuming "now" — the rolling-24h cap arithmetic and the visible
 * history both depend on getting this instant right, not just the acknowledgement time.
 *
 * No time-picker library is installed (deliberately — avoiding a new, unverifiable native
 * module), so "Another time" is a plain `HH:MM` text input, validated with a regex and shown
 * inline as an error rather than guaranteed correct by an input widget the way web's
 * `<input type="time">` is.
 */
export function TakenTimePrompt({
  dueAtIso,
  nowMs,
  timeZone,
  saving,
  onConfirm,
  onCancel,
}: {
  dueAtIso: IsoInstant;
  nowMs: EpochMs;
  timeZone: string;
  saving: boolean;
  onConfirm: (actualTimeIso: IsoInstant) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const dueMs = fromIso(dueAtIso);
  const dueLabel = formatLocalTime(timeZone, dueMs);
  const nowLabel = formatLocalTime(timeZone, nowMs);

  const [customTime, setCustomTime] = useState(nowLabel);
  const [showCustom, setShowCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCustomConfirm = () => {
    if (!TIME_PATTERN.test(customTime)) {
      setError('Enter a time as HH:MM, e.g. 08:15.');
      return;
    }
    setError(null);
    // Resolved against the day the dose was *due*, not today: a 23:00 dose acknowledged after
    // midnight still belongs to the day it was scheduled for.
    const resolved = resolveLocal(timeZone, formatLocalDate(timeZone, dueMs), customTime);
    onConfirm(toIso(resolved.instantMs));
  };

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>When was it actually taken?</Text>

      {!showCustom ? (
        <View style={[ui.row, { flexWrap: 'wrap' }]}>
          <Button label={`On time — ${dueLabel}`} onPress={() => onConfirm(dueAtIso)} disabled={saving} variant="primary" />
          <Button label={`Just now — ${nowLabel}`} onPress={() => onConfirm(toIso(nowMs))} disabled={saving} />
          <Button label="Another time" onPress={() => setShowCustom(true)} disabled={saving} />
          <Button label="Cancel" onPress={onCancel} disabled={saving} />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={ui.row}>
            <TextInput
              style={[ui.input, { width: 100 }]}
              value={customTime}
              editable={!saving}
              onChangeText={(value) => {
                setCustomTime(value);
                setError(null);
              }}
              placeholder="08:15"
              accessibilityLabel="Time taken"
            />
            <Button
              label={saving ? 'Recording…' : 'Save'}
              onPress={handleCustomConfirm}
              disabled={saving || !customTime}
              variant="primary"
            />
            <Button label="Cancel" onPress={onCancel} disabled={saving} />
          </View>
          {error ? (
            <Text style={ui.errorText} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
