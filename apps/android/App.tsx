import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet } from 'react-native';

import { SpikeScreen } from './src/features/spike/SpikeScreen';

/**
 * Sprint A0 is scaffold-only: this renders the exit-gate spike screen and nothing else.
 * Feature-parity screens (Today, Medicines, Schedules, …) are Sprint A2
 * (docs/android-client-plan.md, "Sprints").
 */
export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <SpikeScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F7F5F0' },
});
