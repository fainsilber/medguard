import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import './index.css';

/**
 * Composition root. This is where the real clock and real id generator are constructed and
 * handed downward — the rest of the app takes them as dependencies (see packages/shared/clock.ts).
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container missing from index.html');
}

registerSW({ immediate: true });

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
