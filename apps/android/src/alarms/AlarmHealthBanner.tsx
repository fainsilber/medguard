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

  // Blockers always need a caregiver to go grant something. Most risks (battery optimisation,
  // DND) and staleness instead resolve themselves once the underlying condition clears — but
  // `no_server_backstop` is the odd one out: it doesn't ever clear on its own (the server has no
  // way to know this device exists until it registers), and unlike a permission grant, retrying
  // it is exactly what `AlarmSetupChecklist`'s "Server alerts" row does. So it earns a fix flow
  // too, even though it's a risk rather than a blocker.
  const showFixAction = health.blockers.length > 0 || health.risks.includes('no_server_backstop');

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
