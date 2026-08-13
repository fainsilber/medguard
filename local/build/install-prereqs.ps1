<#
.SYNOPSIS
    Installs everything `run-android.ps1` needs: Node 20+, a JDK 17+, the Android SDK
    (command-line tools, platform-tools, emulator, a system image) and one AVD.

.DESCRIPTION
    The "Prerequisites" section of local/build/README.md, done for you. Every step checks
    before it installs, so re-running is cheap and safe — it is also the fastest way to find
    out *which* prerequisite is missing on a fresh machine.

    Steps, in order:
      1. Node 20+                — winget, if the installed Node is missing or too old.
      2. JDK 17+                 — winget (Temurin 17, what CI uses), same condition.
      3. Android SDK             — cmdline-tools downloaded straight from dl.google.com, then
                                   `sdkmanager` for platform-tools, the emulator, a platform
                                   and a system image. SDK licences are accepted as part of it.
      4. An AVD                  — created with `avdmanager` if you have none.
      5. npm install             — at the repo root, if node_modules is missing.

    Expect ~2-3 GB of downloads and 10+ minutes on a machine with none of it installed. The
    Android SDK is the bulk of that; the system image alone is over a gigabyte.

    Persistent changes it makes outside the SDK directory: ANDROID_HOME (and JAVA_HOME, if a
    JDK gets installed and nothing set it) as *user* environment variables, so new terminals
    and `run-android.ps1` can find them. Nothing is written to machine scope, and nothing
    needs an elevated prompt except what winget itself asks for.

.PARAMETER CheckOnly
    Report what is present and what is missing, then exit without installing anything.
    Run this first if you would rather see the damage before agreeing to it.

.PARAMETER SdkRoot
    Where to install the Android SDK. Defaults to an SDK already on this machine (the same
    places run-android.ps1 looks), or %LOCALAPPDATA%\Android\Sdk on a machine with none.

.PARAMETER ApiLevel
    Android API level for the platform and emulator system image. Defaults to 36 (Android 16),
    which is what Expo SDK 57 / React Native 0.86 compile against.

.PARAMETER AvdName
    Name for the AVD to create. Defaults to 'medguard'. An existing AVD by this name is left
    alone, and if you already have *any* AVD, none is created unless you pass -Force.

.PARAMETER SkipNode
    Leave Node alone even if it is missing or older than 20.

.PARAMETER SkipJava
    Leave Java alone even if it is missing or older than 17.

.PARAMETER SkipAndroidSdk
    Don't touch the Android SDK.

.PARAMETER SkipAvd
    Don't create an AVD. Use when you only ever run on a physical phone.

.PARAMETER SkipNpmInstall
    Don't run npm install at the repo root.

.PARAMETER Force
    Create the AVD even if other AVDs already exist.

.EXAMPLE
    .\local\build\install-prereqs.ps1 -CheckOnly
    Print a readiness report and change nothing.

.EXAMPLE
    .\local\build\install-prereqs.ps1
    Install whatever is missing, then create a 'medguard' AVD if there are none.

.EXAMPLE
    .\local\build\install-prereqs.ps1 -ApiLevel 35 -AvdName medguard_35 -Force
    Add a second AVD on an older API level, alongside whatever you already have.

.NOTES
    The small Write-Step/Write-Note/Stop-WithGuidance helpers are duplicated from
    run-android.ps1 rather than shared: a script whose job is to fix a broken machine should
    not itself depend on a second file being present and dot-sourceable.
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$SdkRoot,
    [int]$ApiLevel = 36,
    [string]$AvdName = 'medguard',
    [switch]$SkipNode,
    [switch]$SkipJava,
    [switch]$SkipAndroidSdk,
    [switch]$SkipAvd,
    [switch]$SkipNpmInstall,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AndroidApp = Join-Path $RepoRoot 'apps\android'

$MinNodeMajor = 20   # package.json's engines.node
$MinJavaMajor = 17   # the Android Gradle Plugin's floor; .github/workflows/android-apk.yml pins 17

$SdkRepositoryUrl = 'https://dl.google.com/android/repository/repository2-3.xml'

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Ok { param([string]$Message) Write-Host "    OK   $Message" -ForegroundColor Green }
function Write-Missing { param([string]$Message) Write-Host "    MISS $Message" -ForegroundColor Yellow }

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

# Native tools don't throw on failure, they set $LASTEXITCODE. They also use stderr for ordinary
# progress chatter (sdkmanager's download bar, avdmanager's warnings, `java -version` in its
# entirety), and with $ErrorActionPreference = 'Stop' that alone can abort the script on some
# PowerShell versions — so stderr is demoted for the length of the call and the exit code is
# treated as the only failure signal.
function Invoke-Tool {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$StdIn,
        [string]$WorkingDirectory,
        [switch]$PassThru,
        [switch]$AllowFailure
    )
    Write-Note "$([System.IO.Path]::GetFileName($FilePath)) $($Arguments -join ' ')"
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PassThru) {
            if ($PSBoundParameters.ContainsKey('StdIn')) {
                $output = @($StdIn | & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
            }
            else {
                $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
            }
        }
        else {
            # Not captured: long downloads should show progress as it happens.
            if ($PSBoundParameters.ContainsKey('StdIn')) { $StdIn | & $FilePath @Arguments }
            else { & $FilePath @Arguments }
            $output = @()
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
        if ($WorkingDirectory) { Pop-Location }
    }

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        if ($PassThru) { $output | ForEach-Object { Write-Host $_ } }
        throw "``$FilePath $($Arguments -join ' ')`` failed with exit code $exitCode."
    }
    if ($PassThru) { return $output }
}

function Get-CommandVersionMajor {
    <#
        Runs `<tool> <versionArg>` and pulls the leading major version out of it. Returns $null
        when the tool is absent or prints something unparseable — both of which callers treat as
        "not usable", never as a hard failure.
    #>
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$VersionArgument,
        [Parameter(Mandatory)][string]$Pattern
    )
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $null }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $text = (& $Command $VersionArgument 2>&1 | ForEach-Object { "$_" }) -join "`n" }
    catch { return $null }
    finally { $ErrorActionPreference = $previousPreference }
    if ($text -match $Pattern) { return [int]$Matches[1] }
    return $null
}

function Test-Winget {
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param(
        [Parameter(Mandatory)][string]$PackageId,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$ManualUrl
    )
    if (-not (Test-Winget)) {
        Stop-WithGuidance -Summary "$DisplayName is missing and winget isn't available to install it." -Guidance @"
Install $DisplayName by hand, then re-run this script:
  $ManualUrl

winget itself ships with App Installer from the Microsoft Store:
  https://apps.microsoft.com/detail/9nblggh4nns1
"@
    }
    Write-Note "Installing $DisplayName via winget ($PackageId)"
    # --silent keeps installers from opening dialogs; the two accept flags are what make winget
    # usable unattended at all. Exit code 0 is a real install, and winget's own "already
    # installed"/"no upgrade" codes are not failures here.
    Invoke-Tool -FilePath 'winget' -AllowFailure -Arguments @(
        'install', '--id', $PackageId, '--exact', '--silent',
        '--accept-package-agreements', '--accept-source-agreements'
    )
}

function Add-ToProcessPath {
    <# So later steps of *this* run can use what an earlier step just installed. #>
    param([Parameter(Mandatory)][string]$Directory)
    if ((Test-Path $Directory) -and ($env:PATH -notlike "*$Directory*")) {
        $env:PATH = "$Directory;$env:PATH"
    }
}

function Set-UserEnvironmentVariable {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
    Set-Item -Path "env:$Name" -Value $Value
    Write-Note "$Name=$Value (user environment variable; new terminals pick it up)"
}

# ---------------------------------------------------------------------------------------------
# Detection — everything the report and the install path both need to know
# ---------------------------------------------------------------------------------------------

function Resolve-ExistingSdk {
    # Same candidate list as run-android.ps1, so the two scripts can't disagree about which SDK
    # is "the" SDK on a machine that has more than one.
    $candidates = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
        'C:\Android\Sdk'
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools\adb.exe')) }

    if ($candidates) { return @($candidates)[0] }
    return $null
}

function Resolve-SdkRoot {
    if ($SdkRoot) { return $SdkRoot }
    $existing = Resolve-ExistingSdk
    if ($existing) { return $existing }
    # Nothing installed: pick the location Android Studio would have used, which run-android.ps1
    # already falls back to even when ANDROID_HOME is unset.
    return (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
}

$Sdk = Resolve-SdkRoot
$SdkManager = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
$AvdManager = Join-Path $Sdk 'cmdline-tools\latest\bin\avdmanager.bat'
$AdbExe = Join-Path $Sdk 'platform-tools\adb.exe'
$EmulatorExe = Join-Path $Sdk 'emulator\emulator.exe'

# x86_64 images on Intel/AMD, arm64-v8a on an ARM Windows box. Getting this wrong produces an
# AVD that "exists" but refuses to boot, which is a confusing failure to debug later.
$SystemImageAbi = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64-v8a' } else { 'x86_64' }
$SystemImagePackage = "system-images;android-$ApiLevel;google_apis;$SystemImageAbi"
$RequiredSdkPackages = @(
    'platform-tools',
    'emulator',
    "platforms;android-$ApiLevel",
    $SystemImagePackage
)

function Get-InstalledAvdNames {
    if (-not (Test-Path $AvdManager)) { return @() }
    # -c prints bare names, one per line — everything else avdmanager prints is a table meant
    # for humans. Failures are tolerated: a machine with no AVD home yet is not an error.
    $names = Invoke-Tool -FilePath $AvdManager -Arguments @('list', 'avd', '-c') -PassThru -AllowFailure
    return @($names | Where-Object { $_ -and $_.Trim() -and $_ -notmatch '^(Warning|Error|Parsing)' } | ForEach-Object { $_.Trim() })
}

function Get-Readiness {
    $nodeMajor = Get-CommandVersionMajor -Command 'node' -VersionArgument '--version' -Pattern 'v(\d+)'
    $javaMajor = Get-CommandVersionMajor -Command 'java' -VersionArgument '-version' -Pattern '(?:version|openjdk)\s+"?(\d+)'
    # @(...) around the whole thing: an empty array returned from a function collapses to $null
    # on the way out, and $null.Count throws under Set-StrictMode.
    $avds = @(if (Test-Path $AvdManager) { Get-InstalledAvdNames })

    return [pscustomobject]@{
        NodeMajor       = $nodeMajor
        NodeOk          = ($null -ne $nodeMajor -and $nodeMajor -ge $MinNodeMajor)
        JavaMajor       = $javaMajor
        JavaOk          = ($null -ne $javaMajor -and $javaMajor -ge $MinJavaMajor)
        CmdlineToolsOk  = (Test-Path $SdkManager)
        PlatformToolsOk = (Test-Path $AdbExe)
        EmulatorOk      = (Test-Path $EmulatorExe)
        SystemImageOk   = (Test-Path (Join-Path $Sdk "system-images\android-$ApiLevel\google_apis\$SystemImageAbi"))
        Avds            = $avds
        AvdOk           = ($avds.Count -gt 0)
        NodeModulesOk   = (Test-Path (Join-Path $AndroidApp 'node_modules'))
    }
}

if ($CheckOnly) {
    Write-Step "Prerequisite check (SDK root: $Sdk)"
    $state = Get-Readiness

    if ($state.NodeOk) { Write-Ok "Node v$($state.NodeMajor)" }
    elseif ($state.NodeMajor) { Write-Missing "Node v$($state.NodeMajor) is older than the required $MinNodeMajor" }
    else { Write-Missing 'Node is not installed' }

    if ($state.JavaOk) { Write-Ok "Java $($state.JavaMajor)" }
    elseif ($state.JavaMajor) { Write-Missing "Java $($state.JavaMajor) is older than the required $MinJavaMajor" }
    else { Write-Missing 'No JDK on PATH' }

    if ($state.CmdlineToolsOk) { Write-Ok 'Android SDK command-line tools' } else { Write-Missing 'Android SDK command-line tools' }
    if ($state.PlatformToolsOk) { Write-Ok 'platform-tools (adb)' } else { Write-Missing 'platform-tools (adb)' }
    if ($state.EmulatorOk) { Write-Ok 'emulator' } else { Write-Missing 'emulator' }
    if ($state.SystemImageOk) { Write-Ok $SystemImagePackage } else { Write-Missing $SystemImagePackage }
    if ($state.AvdOk) { Write-Ok "AVDs: $($state.Avds -join ', ')" } else { Write-Missing 'No AVD exists' }
    if ($state.NodeModulesOk) { Write-Ok 'npm dependencies installed' } else { Write-Missing 'npm dependencies (node_modules)' }

    $ready = $state.NodeOk -and $state.JavaOk -and $state.PlatformToolsOk -and $state.EmulatorOk -and $state.AvdOk -and $state.NodeModulesOk
    if ($ready) {
        Write-Host "`nReady — run .\local\build\run-android.ps1" -ForegroundColor Green
    }
    else {
        Write-Host "`nNot ready — run .\local\build\install-prereqs.ps1 (no -CheckOnly) to fix the above." -ForegroundColor Yellow
    }
    exit 0
}

# ---------------------------------------------------------------------------------------------
# 1. Node
# ---------------------------------------------------------------------------------------------

Write-Step 'Node'
if ($SkipNode) {
    Write-Note 'Skipped (-SkipNode)'
}
else {
    $nodeMajor = Get-CommandVersionMajor -Command 'node' -VersionArgument '--version' -Pattern 'v(\d+)'
    if ($null -ne $nodeMajor -and $nodeMajor -ge $MinNodeMajor) {
        Write-Ok "Node v$nodeMajor already installed"
    }
    else {
        if ($nodeMajor) { Write-Note "Node v$nodeMajor is older than $MinNodeMajor (package.json engines.node)" }
        Install-WithWinget -PackageId 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS' -ManualUrl 'https://nodejs.org/en/download'
        # The installer edits the *machine* PATH, which this already-running process never sees.
        Add-ToProcessPath (Join-Path $env:ProgramFiles 'nodejs')
        $nodeMajor = Get-CommandVersionMajor -Command 'node' -VersionArgument '--version' -Pattern 'v(\d+)'
        if ($null -eq $nodeMajor) {
            Write-Warning 'Node was installed but is not on this terminal''s PATH yet. Open a new terminal and re-run.'
        }
        else { Write-Ok "Node v$nodeMajor" }
    }
}

# ---------------------------------------------------------------------------------------------
# 2. JDK
# ---------------------------------------------------------------------------------------------

Write-Step 'JDK'
if ($SkipJava) {
    Write-Note 'Skipped (-SkipJava)'
}
else {
    $javaMajor = Get-CommandVersionMajor -Command 'java' -VersionArgument '-version' -Pattern '(?:version|openjdk)\s+"?(\d+)'
    if ($null -ne $javaMajor -and $javaMajor -ge $MinJavaMajor) {
        Write-Ok "Java $javaMajor already installed"
        if ($javaMajor -ne 17) {
            # Not a problem, just worth knowing: CI pins 17, so a Gradle failure that only happens
            # locally is worth blaming on the JDK first.
            Write-Note "CI builds on JDK 17; yours is $javaMajor. Usually fine."
        }
    }
    else {
        if ($javaMajor) { Write-Note "Java $javaMajor is older than the Android Gradle Plugin's minimum of $MinJavaMajor" }
        Install-WithWinget -PackageId 'EclipseAdoptium.Temurin.17.JDK' -DisplayName 'Eclipse Temurin 17 JDK' -ManualUrl 'https://adoptium.net/temurin/releases/?version=17'

        $installedJdk = Get-ChildItem (Join-Path $env:ProgramFiles 'Eclipse Adoptium') -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($installedJdk) {
            Add-ToProcessPath (Join-Path $installedJdk.FullName 'bin')
            # Gradle finds a JDK through JAVA_HOME first. Only set it if nothing already has —
            # silently repointing a machine that deliberately uses another JDK would be rude.
            if (-not $env:JAVA_HOME) { Set-UserEnvironmentVariable -Name 'JAVA_HOME' -Value $installedJdk.FullName }
            Write-Ok "Temurin 17 at $($installedJdk.FullName)"
        }
        else {
            Write-Warning 'Temurin was installed but not found under Program Files\Eclipse Adoptium. Open a new terminal and re-run to verify.'
        }
    }
}

# ---------------------------------------------------------------------------------------------
# 3. Android SDK
# ---------------------------------------------------------------------------------------------

function Install-CmdlineTools {
    <#
        Bootstraps the SDK from nothing. The command-line tools package is the only piece that
        can't be installed by sdkmanager (it *is* sdkmanager), so it comes straight from Google's
        repository manifest — which is parsed rather than hardcoded because the download URL
        carries a build number that changes with every release.
    #>
    Write-Note "Looking up the current command-line tools in $SdkRepositoryUrl"
    $previousProgress = $ProgressPreference
    # Invoke-WebRequest's progress bar costs more time than the download on a fast connection.
    $ProgressPreference = 'SilentlyContinue'
    try {
        $manifest = [xml](Invoke-WebRequest -Uri $SdkRepositoryUrl -UseBasicParsing).Content
        $archive = $manifest.SelectSingleNode(
            "//remotePackage[@path='cmdline-tools;latest']/archives/archive[host-os='windows']/complete")
        if (-not $archive) { throw "Google's SDK manifest has no Windows command-line tools archive." }

        $zipName = $archive.SelectSingleNode('url').InnerText
        $expectedSha1 = $archive.SelectSingleNode('checksum').InnerText
        $downloadUrl = "https://dl.google.com/android/repository/$zipName"

        $temp = Join-Path ([System.IO.Path]::GetTempPath()) "medguard-sdk-$([System.Guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Path $temp | Out-Null
        try {
            $zipPath = Join-Path $temp $zipName
            Write-Note "Downloading $zipName (about 150 MB)"
            Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

            $actualSha1 = (Get-FileHash -Path $zipPath -Algorithm SHA1).Hash
            if ($actualSha1 -ne $expectedSha1.ToUpperInvariant()) {
                throw "Checksum mismatch on $zipName (expected $expectedSha1, got $actualSha1). Refusing to unpack it."
            }

            Write-Note 'Unpacking'
            Expand-Archive -Path $zipPath -DestinationPath $temp -Force
            # The zip's top-level folder is literally 'cmdline-tools'; sdkmanager insists on
            # living at <sdk>\cmdline-tools\latest\ and fails with a "Could not determine SDK
            # root" error anywhere else.
            $target = Join-Path $Sdk 'cmdline-tools\latest'
            if (-not (Test-Path $Sdk)) { New-Item -ItemType Directory -Path $Sdk -Force | Out-Null }
            if (Test-Path $target) { Remove-Item $target -Recurse -Force }
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            Move-Item -Path (Join-Path $temp 'cmdline-tools') -Destination $target
        }
        finally {
            Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        $ProgressPreference = $previousProgress
    }
    Write-Ok "Command-line tools installed at $Sdk\cmdline-tools\latest"
}

Write-Step "Android SDK ($Sdk)"
if ($SkipAndroidSdk) {
    Write-Note 'Skipped (-SkipAndroidSdk)'
}
else {
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
        Stop-WithGuidance -Summary 'sdkmanager needs a JDK on PATH and there is none.' -Guidance @"
A JDK was either skipped (-SkipJava) or installed into a PATH this terminal can't see yet.

Open a new terminal and re-run:
  .\local\build\install-prereqs.ps1
"@
    }

    # Both are read by sdkmanager, avdmanager, Gradle and Expo's own SDK lookup. Setting them
    # before the first sdkmanager call also stops it from installing into its own parent dir.
    $env:ANDROID_HOME = $Sdk
    $env:ANDROID_SDK_ROOT = $Sdk

    if (Test-Path $SdkManager) { Write-Ok 'Command-line tools already installed' }
    else { Install-CmdlineTools }

    Write-Note 'Accepting SDK licences'
    # `sdkmanager --licenses` is an interactive y/N prompt per unaccepted licence, and there is no
    # non-interactive flag. Feeding it a stream of 'y' is the documented way through; already-
    # accepted licences make it a no-op that prints "All SDK package licenses accepted".
    $yes = ((1..50 | ForEach-Object { 'y' }) -join "`n") + "`n"
    Invoke-Tool -FilePath $SdkManager -Arguments @('--licenses') -StdIn $yes -AllowFailure

    Write-Note "Installing: $($RequiredSdkPackages -join ', ')"
    Write-Note 'The system image is over a gigabyte — this is the slow part.'
    Invoke-Tool -FilePath $SdkManager -Arguments $RequiredSdkPackages -StdIn $yes

    if (-not (Test-Path $AdbExe)) {
        throw "platform-tools still missing after sdkmanager ran — expected $AdbExe."
    }
    Add-ToProcessPath (Join-Path $Sdk 'platform-tools')
    Add-ToProcessPath (Join-Path $Sdk 'emulator')

    # run-android.ps1 falls back to %LOCALAPPDATA%\Android\Sdk, but anything else on this machine
    # (Gradle, Android Studio, a plain `adb`) expects ANDROID_HOME to be set properly.
    if ($env:ANDROID_HOME -ne [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')) {
        Set-UserEnvironmentVariable -Name 'ANDROID_HOME' -Value $Sdk
    }
    Write-Ok 'Android SDK ready'
}

# ---------------------------------------------------------------------------------------------
# 4. AVD
# ---------------------------------------------------------------------------------------------

Write-Step 'Emulator (AVD)'
if ($SkipAvd) {
    Write-Note 'Skipped (-SkipAvd)'
}
elseif (-not (Test-Path $AvdManager)) {
    Write-Warning "No avdmanager at $AvdManager — skipping AVD creation. Re-run without -SkipAndroidSdk."
}
else {
    $existingAvds = @(Get-InstalledAvdNames)
    if ($existingAvds -contains $AvdName) {
        Write-Ok "AVD '$AvdName' already exists"
    }
    elseif ($existingAvds.Count -gt 0 -and -not $Force) {
        Write-Ok "AVDs already exist: $($existingAvds -join ', ')"
        Write-Note "Pass -Force to add '$AvdName' as well."
    }
    else {
        Write-Note "Creating AVD '$AvdName' from $SystemImagePackage"
        $createArgs = @('create', 'avd', '--name', $AvdName, '--package', $SystemImagePackage)

        # A hardware profile gives the AVD a sane screen and RAM instead of avdmanager's rather
        # small default. Which ids exist depends on the installed tools version, so the profile is
        # looked up rather than hardcoded — an unknown id makes `create avd` fail outright, and
        # failing here would waste the multi-gigabyte download that just happened.
        $deviceIds = @(Invoke-Tool -FilePath $AvdManager -Arguments @('list', 'device', '-c') -PassThru -AllowFailure |
            ForEach-Object { $_.Trim() })
        $profile = @('pixel_7', 'pixel_6', 'pixel_5', 'pixel') | Where-Object { $deviceIds -contains $_ } | Select-Object -First 1
        if ($profile) { $createArgs += @('--device', $profile) }
        else { Write-Note 'No known Pixel hardware profile available; using avdmanager defaults.' }

        # avdmanager asks "Do you wish to create a custom hardware profile? [no]" on stdin and
        # will sit there forever waiting for an answer if nothing is piped in.
        Invoke-Tool -FilePath $AvdManager -StdIn "no`n" -Arguments $createArgs
        Write-Ok "AVD '$AvdName' created$(if ($profile) { " ($profile)" })"
    }
}

# ---------------------------------------------------------------------------------------------
# 5. Repo dependencies
# ---------------------------------------------------------------------------------------------

Write-Step 'npm dependencies'
if ($SkipNpmInstall) {
    Write-Note 'Skipped (-SkipNpmInstall)'
}
elseif (Test-Path (Join-Path $AndroidApp 'node_modules')) {
    Write-Ok 'Already installed'
}
elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Warning 'npm is not on this terminal''s PATH yet. Open a new terminal and run `npm install` at the repo root.'
}
else {
    Invoke-Tool -FilePath 'npm.cmd' -Arguments @('install') -WorkingDirectory $RepoRoot
    Write-Ok 'Installed'
}

# ---------------------------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------------------------

Write-Step 'Done'
Write-Host @"
Prerequisites are in place. Open a NEW terminal (so ANDROID_HOME and any freshly installed
tools are on PATH), then:

  .\local\build\run-android.ps1

To re-check without changing anything:

  .\local\build\install-prereqs.ps1 -CheckOnly

If the emulator starts but is unusably slow, hardware acceleration is off: enable virtualisation
in the BIOS, and Windows Features > Windows Hypervisor Platform.
"@ -ForegroundColor Green
