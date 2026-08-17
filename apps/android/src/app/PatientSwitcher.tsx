import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../ui/primitives.js';
import { usePatients } from './PatientProvider.js';
import type { PatientSelection } from './PatientProvider.js';

/**
 * The header control that decides which patient's data every screen shows — the RN port of
 * `apps/web/src/app/PatientSwitcher.tsx`. RN has no native `<select>`, so this is a `Pressable`
 * showing the current selection that opens a `Modal` list of options, the same shape App.tsx's
 * own hamburger menu already uses.
 *
 * Hidden entirely for a single-patient household — a switcher with one real option and "All"
 * (which shows the same thing) is a control with nothing to decide.
 */
export function PatientSwitcher(): React.JSX.Element | null {
  const { patients, selection, select } = usePatients();
  const [open, setOpen] = useState(false);

  if (patients.length <= 1) {
    return null;
  }

  const currentLabel =
    selection === 'all'
      ? 'All patients'
      : (patients.find((patient) => patient.id === selection)?.displayName ?? 'All patients');

  const choose = (next: PatientSelection) => {
    select(next);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Patient"
        onPress={() => setOpen(true)}
        style={styles.button}
      >
        <Text style={styles.buttonLabel} numberOfLines={1}>
          {currentLabel}
        </Text>
        <Text style={styles.caret}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          onPress={() => setOpen(false)}
        >
          <View style={styles.menu}>
            <Pressable accessibilityRole="button" style={styles.item} onPress={() => choose('all')}>
              <Text style={[styles.itemLabel, selection === 'all' && styles.itemLabelActive]}>
                All patients
              </Text>
            </Pressable>
            {patients.map((patient) => (
              <Pressable
                key={patient.id}
                accessibilityRole="button"
                style={styles.item}
                onPress={() => choose(patient.id)}
              >
                <Text
                  style={[styles.itemLabel, selection === patient.id && styles.itemLabelActive]}
                >
                  {patient.displayName}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxWidth: 130,
  },
  buttonLabel: { fontSize: 13, fontWeight: '600', color: colors.text, flexShrink: 1 },
  caret: { fontSize: 10, color: colors.textMuted },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menu: {
    minWidth: 210,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 4,
  },
  item: { paddingVertical: 12, paddingHorizontal: 16 },
  itemLabel: { fontSize: 15, color: colors.text },
  itemLabelActive: { color: colors.primary, fontWeight: '700' },
});
