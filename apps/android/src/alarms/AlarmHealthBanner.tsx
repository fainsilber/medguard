import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { describeAlarmStatus } from './alarmHealth.js';
import { AlarmSetupChecklist } from './AlarmSetupChecklist.js';
import { useAlarmHealth } from './AlarmProvider.js';
import { colors } from '../ui/primitives.js';

/**
 * Safety invariant 6, for the alarm layer specifically: if alarms cannot fire, or the data they'd
 * fire from is stale, the UI says so loudly rather than looking like a normally-working app.
 *
 * The wording comes from `describeAlarmStatus` — the same function that composes the ongoing
 * `sync_status_v1` notification — so a caregiver sees one consistent explanation whether they're
 * looking at the phone or the notification shade.
 *
 * Silent (renders nothing) whenever there's nothing to report, which is the common case: most
 * households most of the time have working alarms and a recent sync.
 */
export function AlarmHealthBanner(): React.JSX.Element | null {
  const { health, staleness } = useAlarmHealth();
  const [expanded, setExpanded] = useState(false);

  if (!health || !staleness) {
    // Still loading the first reconcile pass — nothing to report yet either way.
    return null;
  }

  const status = describeAlarmStatus(health, staleness);
  if (!status) {
    return null;
  }

  // Blockers are the only case worth an explicit fix flow: a risk (battery optimisation, DND)
  // and staleness both resolve themselves once the underlying condition clears, but a blocker
  // needs a caregiver to actually go grant something.
  const showFixAction = health.blockers.length > 0;

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.title}>{status.title}</Text>
      <Text style={styles.body}>{status.body}</Text>

      {showFixAction ? (
        <Pressable onPress={() => setExpanded((current) => !current)} accessibilityRole="button">
          <Text style={styles.link}>{expanded ? 'Hide setup checklist' : 'Fix this'}</Text>
        </Pressable>
      ) : null}

      {expanded ? <AlarmSetupChecklist /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.locked,
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    padding: 12,
  },
  title: { fontSize: 14, fontWeight: '700', color: colors.text },
  body: { fontSize: 13, color: colors.text },
  link: { fontSize: 13, color: colors.primary, textDecorationLine: 'underline' },
});
