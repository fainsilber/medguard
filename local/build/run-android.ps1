<#
.SYNOPSIS
    Compiles, builds, installs and runs the MedGuard Android app on a local emulator (or an
    attached phone).

.DESCRIPTION
    The local equivalent of README Option B ("local build via Android Studio / the SDK
    command-line tools") in apps/android/README.md, with the manual steps - SDK discovery,
    booting an emulator, waiting for it to finish booting - done for you.

    Steps, in order:
      1. Resolve the Android SDK and put platform-tools/emulator on PATH for this process only.
      2. Sanity-check Java (Gradle needs 17+).
      3. npm install at the repo root, if node_modules is missing.
      4. Pick a target: an already-attached device, or boot an AVD and wait for it.
      5. npx expo prebuild --platform android   (regenerates apps/android/android/, gitignored)
      6. npx expo run:android --device <serial> (builds, installs, starts Metro)

    Nothing here writes outside apps/android/android/ and node_modules/.

.PARAMETER Avd
    Name of the AVD to boot. Defaults to the first one `emulator -list-avds` reports.
    Ignored when -Device is given.

.PARAMETER Device
    An existing adb serial to target (e.g. a physical phone, or an emulator you booted
    yourself). Skips emulator launching entirely.

.PARAMETER Variant
    'debug' (default) or 'release'. Debug needs Metro running to serve the JS bundle - which
    this script starts for you, so it is the right choice for iterating. Release embeds the
    bundle in the APK (what the CI workflow builds); use it when you want to check the app
    standalone, e.g. after killing Metro.

.PARAMETER Clean
    Pass --clean to expo prebuild, wiping and regenerating apps/android/android/ from scratch.
    Use after changing app.config.ts, plugins/withMedGuardAlarms.ts, or native module code.

.PARAMETER ApiBaseUrl
    Sets MEDGUARD_API_BASE_URL for the prebuild, baking a non-default API host into the build's
    Expo `extra`. Leave unset to use src/api/config.ts's real deployed-worker default.

.PARAMETER ColdBoot
    Boot the emulator from a cold start (-no-snapshot-load) instead of restoring its snapshot.
    Slower, but the honest starting point when testing boot-time behaviour like BootReceiver.

.PARAMETER SkipInstall
    Don't run npm install even if node_modules looks absent.

.PARAMETER ListAvds
    Print the available AVDs and exit. Handy for finding a name to pass to -Avd.

.EXAMPLE
    .\local\build\run-android.ps1
    Boot the first AVD, build a debug APK, install and run it.

.EXAMPLE
    .\local\build\run-android.ps1 -Avd Pixel_7_API_35 -Clean
    Regenerate the native project from scratch, then run on a named AVD.

.EXAMPLE
    .\local\build\run-android.ps1 -Device R58M1234ABC -Variant release
    Build a standalone release APK onto a USB-attached phone (see `adb devices` for serials).
#>
[CmdletBinding()]
param(
    [string]$Avd,
    [string]$Device,
    [ValidateSet('debug', 'release')]
    [string]$Variant = 'debug',
    [switch]$Clean,
    [string]$ApiBaseUrl,
    [switch]$ColdBoot,
    [switch]$SkipInstall,
    [switch]$ListAvds
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# How long to wait for `sys.boot_completed` after launching the emulator. A cold boot of a
# recent system image on a machine without hardware acceleration genuinely can take minutes,
# so this is deliberately generous rather than tuned to a fast machine.
$BootTimeoutSeconds = 300

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AndroidApp = Join-Path $RepoRoot 'apps\android'

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

# PowerShell's error formatter reflows a multi-line `throw` message into one wrapped blob, which
# turns setup instructions into an unreadable paragraph. Print those to the host first, then throw
# a one-line summary.
function Stop-WithGuidance {
    param(
        [Parameter(Mandatory)][string]$Summary,
        [Parameter(Mandatory)][string]$Guidance
    )
    Write-Host "`n$Summary`n" -ForegroundColor Red
    Write-Host $Guidance -ForegroundColor Yellow
    throw $Summary
}

# Native executables don't throw on failure, they set $LASTEXITCODE - so every call to one goes
# through here. Without this a failed Gradle build would fall through to "done" and look green.
function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
        Write-Note "$FilePath $($Arguments -join ' ')"
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "``$FilePath $($Arguments -join ' ')`` failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        if ($WorkingDirectory) { Pop-Location }
    }
}

# ---------------------------------------------------------------------------------------------
# 1. Android SDK
# ---------------------------------------------------------------------------------------------

function Resolve-AndroidSdk {
    $candidates = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
        'C:\Android\Sdk'
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools\adb.exe')) }

    if (-not $candidates) {
        Stop-WithGuidance -Summary 'No Android SDK found.' -Guidance @"
Looked for platform-tools\adb.exe under ANDROID_HOME, ANDROID_SDK_ROOT,
%LOCALAPPDATA%\Android\Sdk and C:\Android\Sdk.

Install one of:
  - Android Studio (easiest): https://developer.android.com/studio
    During setup let it install the SDK, then Tools > Device Manager to create an emulator (AVD).
  - Command-line tools only: https://developer.android.com/studio#command-line-tools-only

Then set ANDROID_HOME and open a new terminal:
  [Environment]::SetEnvironmentVariable('ANDROID_HOME', "`$env:LOCALAPPDATA\Android\Sdk", 'User')
"@
    }

    return @($candidates)[0]
}

$Sdk = Resolve-AndroidSdk
Write-Step "Android SDK: $Sdk"

# Gradle and expo's own SDK lookup both read these; set them for child processes even when the
# SDK was found by falling back to a well-known path rather than from the environment.
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk

$AdbExe = Join-Path $Sdk 'platform-tools\adb.exe'
$EmulatorExe = Join-Path $Sdk 'emulator\emulator.exe'
$env:PATH = "$Sdk\platform-tools;$Sdk\emulator;$env:PATH"

if ($ListAvds) {
    if (-not (Test-Path $EmulatorExe)) { throw "No emulator installed at $EmulatorExe." }
    & $EmulatorExe -list-avds
    exit 0
}

# ---------------------------------------------------------------------------------------------
# 2. Java
# ---------------------------------------------------------------------------------------------

Write-Step 'Checking Java'
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    throw "No `java` on PATH. Gradle needs a JDK 17+ (Temurin 17 is what CI uses: https://adoptium.net)."
}
$javaVersionOutput = (& java -version 2>&1) -join "`n"
if ($javaVersionOutput -match '(?:version|openjdk)\s+"?(\d+)') {
    $javaMajor = [int]$Matches[1]
    Write-Note "java $javaMajor ($($javaCmd.Source))"
    if ($javaMajor -lt 17) {
        throw "Java $javaMajor is too old - the Android Gradle Plugin needs 17+. CI uses Temurin 17."
    }
    if ($javaMajor -ne 17) {
        # Not fatal: newer JDKs generally work. Flagged because .github/workflows/android-apk.yml
        # pins 17, so a Gradle/AGP failure seen only here is worth suspecting the JDK for first.
        Write-Warning "Java $javaMajor differs from CI's JDK 17. If Gradle fails oddly, try 17 via JAVA_HOME."
    }
}
else {
    Write-Warning "Couldn't parse the Java version from: $javaVersionOutput"
}

# ---------------------------------------------------------------------------------------------
# 3. Dependencies
# ---------------------------------------------------------------------------------------------

if (-not $SkipInstall -and -not (Test-Path (Join-Path $AndroidApp 'node_modules'))) {
    Write-Step 'Installing npm dependencies (workspace root)'
    Invoke-Checked -FilePath 'npm.cmd' -Arguments @('install') -WorkingDirectory $RepoRoot
}
else {
    Write-Step 'Dependencies present - skipping npm install'
}

# ---------------------------------------------------------------------------------------------
# 4. Target device
# ---------------------------------------------------------------------------------------------

function Get-AttachedSerials {
    # `adb devices` prints a header line and then "<serial>\t<state>"; only 'device' is usable
    # ('offline' and 'unauthorized' are both states a booting/unaccepted device sits in).
    # The match and the capture read happen in one block on purpose - $Matches set inside a
    # Where-Object is not reliably visible to a following ForEach-Object.
    & $AdbExe devices | Select-Object -Skip 1 | ForEach-Object {
        if ($_.Trim() -match '^(\S+)\s+device$') { $Matches[1] }
    }
}

function Wait-ForBoot {
    param([Parameter(Mandatory)][string]$Serial)
    $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        # 2>&1 because adb writes "device offline"/"device still connecting" to stderr while the
        # emulator is coming up, which is expected noise here rather than an error.
        $booted = (& $AdbExe -s $Serial shell getprop sys.boot_completed 2>&1) -join ''
        if ($booted.Trim() -eq '1') { return }
        Start-Sleep -Seconds 3
    }
    throw "$Serial did not finish booting within $BootTimeoutSeconds seconds."
}

# `expo run:android --device <name>` matches against @expo/cli's own device list, which keys
# emulators by their AVD name (queried via `adb emu avd name`, same as here) and physical devices
# by `ro.product.model` - never by the adb serial. Passing the serial straight through silently
# fails with "Could not find device with name: <serial>", so resolve the same name expo would.
function Resolve-ExpoDeviceName {
    param([Parameter(Mandatory)][string]$Serial)
    if ($Serial -like 'emulator-*') {
        $raw = (& $AdbExe -s $Serial emu avd name 2>&1) -join "`n"
    }
    else {
        $raw = (& $AdbExe -s $Serial shell getprop ro.product.model 2>&1) -join "`n"
    }
    $name = ($raw -split '[\r\n]+')[0].Trim()
    if (-not $name) {
        throw "Could not resolve an expo device name for $Serial from: $raw"
    }
    return $name
}

Write-Step 'Finding a device'
& $AdbExe start-server | Out-Null

if ($Device) {
    $TargetSerial = $Device
    if ((Get-AttachedSerials) -notcontains $TargetSerial) {
        throw "adb does not see '$TargetSerial'. Attached: $((Get-AttachedSerials) -join ', ')"
    }
    Write-Note "Using the requested device $TargetSerial"
}
else {
    $existing = @(Get-AttachedSerials)
    if ($existing.Count -gt 0 -and -not $Avd) {
        $TargetSerial = $existing[0]
        Write-Note "Using the already-attached $TargetSerial (pass -Avd to boot an emulator instead)"
    }
    else {
        if (-not (Test-Path $EmulatorExe)) {
            throw "No emulator installed at $EmulatorExe. Install the 'Android Emulator' SDK component."
        }
        $avds = @(& $EmulatorExe -list-avds | Where-Object { $_.Trim() })
        if ($avds.Count -eq 0) {
            Stop-WithGuidance -Summary 'No Android emulators (AVDs) exist.' -Guidance @"
Create one in Android Studio (Tools > Device Manager > Create Device), or from the command line:

  sdkmanager "system-images;android-35;google_apis;x86_64"
  avdmanager create avd -n medguard -k "system-images;android-35;google_apis;x86_64"

Then re-run this script (add -Avd <name> to pick a specific one).
"@
        }
        $avdName = if ($Avd) { $Avd } else { $avds[0] }
        if ($avds -notcontains $avdName) {
            throw "No AVD named '$avdName'. Available: $($avds -join ', ')"
        }

        Write-Note "Booting AVD '$avdName'$(if ($ColdBoot) { ' (cold boot)' })"
        $emulatorArgs = @('-avd', $avdName)
        if ($ColdBoot) { $emulatorArgs += '-no-snapshot-load' }
        # Detached and in its own window: the emulator must outlive this script, since the
        # installed app stays on it for the manual Diagnostics-tab testing that follows.
        Start-Process -FilePath $EmulatorExe -ArgumentList $emulatorArgs -WorkingDirectory $Sdk | Out-Null

        Write-Note "Waiting for it to appear (up to $BootTimeoutSeconds s)..."
        $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
        $TargetSerial = $null
        while (-not $TargetSerial -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            # Count-then-index rather than a bare [0]: Set-StrictMode -Version Latest throws on
            # indexing an empty array, which is every iteration until the emulator attaches.
            $new = @(Get-AttachedSerials | Where-Object { $existing -notcontains $_ })
            if ($new.Count -gt 0) { $TargetSerial = $new[0] }
        }
        if (-not $TargetSerial) {
            throw "The emulator never showed up in ``adb devices``. Check the emulator window for an error."
        }
        Write-Note "Emulator attached as $TargetSerial"
    }
}

Wait-ForBoot -Serial $TargetSerial
Write-Note "$TargetSerial is booted"

# ---------------------------------------------------------------------------------------------
# 5. Prebuild - generate the native project
# ---------------------------------------------------------------------------------------------

# apps/android/ has no committed android/ directory (continuous native generation - see the
# comment on `config` in app.config.ts), so this step is required, not an optimisation.
Write-Step "Prebuilding the native Android project$(if ($Clean) { ' (clean)' })"
if ($ApiBaseUrl) {
    $env:MEDGUARD_API_BASE_URL = $ApiBaseUrl
    Write-Note "MEDGUARD_API_BASE_URL=$ApiBaseUrl"
}
$prebuildArgs = @('expo', 'prebuild', '--platform', 'android')
if ($Clean) { $prebuildArgs += '--clean' }
Invoke-Checked -FilePath 'npx.cmd' -Arguments $prebuildArgs -WorkingDirectory $AndroidApp

# ---------------------------------------------------------------------------------------------
# 6. Build, install, run
# ---------------------------------------------------------------------------------------------

Write-Step "Building the $Variant APK and installing it on $TargetSerial"
Write-Note 'First run downloads Gradle and the native deps - expect 10+ minutes.'
$ExpoDeviceName = Resolve-ExpoDeviceName -Serial $TargetSerial
Write-Note "Resolved expo device name '$ExpoDeviceName' for $TargetSerial"
$runArgs = @('expo', 'run:android', '--device', $ExpoDeviceName)
if ($Variant -eq 'release') { $runArgs += @('--variant', 'release') }
Invoke-Checked -FilePath 'npx.cmd' -Arguments $runArgs -WorkingDirectory $AndroidApp

Write-Step 'Done'
Write-Host @"
The app is installed on $TargetSerial. Open the Diagnostics tab to run the A0 exit-gate checks
(apps/android/README.md, "The A0 exit gate").

Emulator caveat: the alarm gate itself - alarm-volume audio through a locked, silenced phone -
is only trustworthy on real hardware. An emulator is fine for screens, storage and sync.

Useful while testing:
  adb -s $TargetSerial logcat | Select-String -Pattern medguard
  adb -s $TargetSerial shell dumpsys alarm | Select-String -Pattern il.co.fainsilber.med -Context 0,5
"@ -ForegroundColor Green
