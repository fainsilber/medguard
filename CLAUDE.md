# Working conventions

## Every app must expose its build identity

Any deployable/installable app in this repo (web, Android, API, and any future one) must have
a way to tell which build is running, visible from inside the app itself — not just from CI logs
or a deploy dashboard. At minimum: the git SHA and build timestamp. Ideally also a semver version.

This exists because "did the deploy actually happen" and "which commit is this device running" are
otherwise invisible until a feature is missing or a bug report can't be matched to a commit.

Reference implementations — copy this pattern for new apps rather than inventing a new one:

- **apps/web**: `vite.config.ts`'s `gitShortSha()` bakes `__APP_VERSION__`/`__BUILD_TIME__` into the
  bundle via `define`; `src/version.ts` exposes them with dev/test fallbacks; shown in
  `src/probe/ProbePage.tsx` (`v{APP_VERSION} · built {BUILD_TIME}`).
- **apps/android**: `app.config.ts`'s `gitShortSha()` bakes `gitSha`/`buildTimestamp` into Expo's
  `extra`, captured at `expo prebuild`/build time (works for the plain-Gradle CI build in
  `.github/workflows/android-apk.yml`, which has no EAS remote-version tracking); `src/version.ts`
  reads them via `expo-constants`, plus the installed package's real `nativeBuildVersion` via
  `expo-application`; shown in the "Build" card on `src/features/diagnostics/DiagnosticsScreen.tsx`.

Both fall back gracefully (`'unknown'`/`null`) rather than failing the build if git isn't available.
