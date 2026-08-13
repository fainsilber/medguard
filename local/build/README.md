# local/build — run the Android app locally

Two scripts. `install-prereqs.ps1` gets a Windows machine to the point where the app can be built;
`run-android.ps1` builds it and runs it on an emulator (or an attached phone) in one command. The
latter automates README Option B in `apps/android/README.md` — the manual variant of the same steps
stays there and is still the reference for what each one does.

```powershell
# from anywhere in the repo
.\local\build\install-prereqs.ps1 -CheckOnly   # what's missing?
.\local\build\install-prereqs.ps1              # install it
.\local\build\run-android.ps1                  # build and run
```

That last line will: find the Android SDK, check Java, `npm install` if needed, boot your first AVD
and wait for it, `expo prebuild --platform android`, then `expo run:android` — building a debug
APK, installing it, and starting Metro. Leave that terminal open; Metro serves the JS bundle to the
debug build, and `r` reloads.

## Prerequisites

`install-prereqs.ps1` installs all of these, checking before it installs each one — so re-running
it is cheap, and `-CheckOnly` is the quickest way to find out which one a machine is missing.

- **Android SDK** with platform-tools and the emulator. The script downloads the command-line
  tools straight from Google and drives `sdkmanager` from there, so it does not need
  [Android Studio](https://developer.android.com/studio) — install that too if you want the IDE
  and its Device Manager. `ANDROID_HOME` is set as a user environment variable afterwards.
- **At least one AVD**, created with `avdmanager` from the API 36 Google APIs system image. The
  manual equivalent, if you would rather do it yourself:
  ```powershell
  sdkmanager "system-images;android-36;google_apis;x86_64"
  avdmanager create avd -n medguard -k "system-images;android-36;google_apis;x86_64"
  ```
- **JDK 17+.** CI pins Temurin 17; newer JDKs usually work, and both scripts warn rather than
  refuse. Installed via winget only when what you have is missing or older than 17.
- **Node 20+** and a `npm install` at the repo root (both scripts do the install if `node_modules`
  is missing).

Budget ~2–3 GB of downloads and 10+ minutes on a machine with none of it; the emulator system image
is most of that. Everything lands in the SDK directory — the only changes outside it are the
`ANDROID_HOME` and `JAVA_HOME` user environment variables, and whatever winget installs for Node
and the JDK.

Afterwards, **open a new terminal** before running `run-android.ps1` — a process that was already
running when the installers edited `PATH` can't see the new entries.

## `install-prereqs.ps1` options

| Flag | What it does |
| --- | --- |
| `-CheckOnly` | Report what's present and what's missing, then exit. Installs nothing. |
| `-SdkRoot <path>` | Install the SDK somewhere other than the detected one / `%LOCALAPPDATA%\Android\Sdk`. |
| `-ApiLevel <n>` | API level for the platform and system image. Default 36 (Android 16), what Expo SDK 57 compiles against. |
| `-AvdName <name>` | Name for the AVD it creates. Default `medguard`. |
| `-Force` | Create the AVD even when other AVDs already exist. |
| `-SkipNode` / `-SkipJava` / `-SkipAndroidSdk` / `-SkipAvd` / `-SkipNpmInstall` | Leave that prerequisite alone — for when you manage it yourself (a version manager, a JDK the rest of your work depends on, a phone-only setup). |

## `run-android.ps1` options

| Flag | What it does |
| --- | --- |
| `-Avd <name>` | Boot a specific AVD instead of the first one. Forces an emulator even if a phone is plugged in. |
| `-Device <serial>` | Target an already-attached device (`adb devices` for serials). Skips emulator launching. |
| `-Variant release` | Build the release variant — the JS bundle is embedded, so the app runs without Metro. Same variant CI builds. |
| `-Clean` | `expo prebuild --clean`. Needed after changing `app.config.ts`, `plugins/withMedGuardAlarms.ts`, or anything under `modules/medguard-alarms/`. |
| `-ColdBoot` | Boot the emulator without restoring its snapshot. Slower; the honest start for boot-time behaviour like `BootReceiver`. |
| `-ApiBaseUrl <url>` | Bake a non-default API host into the build. Unset uses `src/api/config.ts`'s deployed-worker default. |
| `-ListAvds` | Print available AVDs and exit. |
| `-SkipInstall` | Never run `npm install`. |

## What an emulator can and can't tell you

Fine on an emulator: every screen, navigation, storage against real `expo-sqlite`, sync and
household join against the deployed API, and whether the app launches at all.

**Not** trustworthy on an emulator: the thing this app exists for. The A0 exit gate — a 45-second
alarm-volume chime through a **locked, silenced phone with the screen off**, auto-stopping with zero
touches — depends on real audio routing, real Doze behaviour, and OEM battery managers that no
emulator models. `apps/android/README.md`'s "Testing the exit gate on a real device" is still the
only way to confirm that, and Option C there (GitHub Actions → sideloadable APK) is the path when
you don't have a cable at hand.

FCM push (Sprint A4's backstop) also needs a `google-services.json` in `apps/android/`; without it
the build is local-alarms-only and Diagnostics reports `no_server_backstop`. That is a supported
state, not a failure.

## Note on `.gitignore`

The repo root ignores `build/` (for build output). `local/build/` is re-included explicitly by a
`!local/build/` line right below it, so these files are tracked. Delete that line if you'd rather
keep this directory local-only.
