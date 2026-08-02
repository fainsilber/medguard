import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

/**
 * Baked into the bundle so a deployed page can be identified from the phone browser alone —
 * the failure mode this exists for is a deploy that silently never happened (e.g. the Cloudflare
 * Git connection dropping), which is otherwise invisible until you notice a feature is missing.
 * Falls back rather than failing the build if git isn't available for some reason.
 */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest rather than generateSW: Sprint 5 needs a hand-written service worker
      // for push and notificationclick, so the SW is ours from the start.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: 'MedGuard',
        short_name: 'MedGuard',
        description: 'Multi-caregiver medication tracking with PRN safety guards',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(gitShortSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@medguard/shared/testing': `${sharedSrc}/testing.ts`,
      '@medguard/shared': `${sharedSrc}/index.ts`,
    },
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
