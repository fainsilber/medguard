import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App), and also
// ensures the environment is set up appropriately for either Expo Go or a native build.
registerRootComponent(App);
