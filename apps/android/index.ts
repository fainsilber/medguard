import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';

import App from './App';
import { runPendingActionsTask } from './src/alarms/headlessTask';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App), and also
// ensures the environment is set up appropriately for either Expo Go or a native build.
registerRootComponent(App);

/**
 * Sprint A4: the headless entry point, for a "Taken"/"Snooze" tap that lands with the app process
 * dead. Started by `MedGuardHeadlessService`, whose `TASK_NAME` must match this string exactly —
 * a mismatch is silent, and the symptom would be a tap that simply never becomes a dose.
 */
AppRegistry.registerHeadlessTask('MedGuardPendingActions', () => runPendingActionsTask);
