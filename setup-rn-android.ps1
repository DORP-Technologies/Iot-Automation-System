Write-Host "=== 1. Checking Node.js & npm ===" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
}
node -v
npm -v

Write-Host "`n=== 2. Checking Java (JDK 17) ===" -ForegroundColor Cyan
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    Write-Host "Java not found. Installing Microsoft OpenJDK 17 via winget..." -ForegroundColor Yellow
    winget install --id Microsoft.OpenJDK.17 -e --accept-source-agreements --accept-package-agreements
}
java -version

Write-Host "`n=== 3. Configuring ANDROID_HOME & PATH ===" -ForegroundColor Cyan
$defaultSdkPath = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $defaultSdkPath }

[Environment]::SetEnvironmentVariable("ANDROID_HOME", $androidHome, "User")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $androidHome, "User")
$env:ANDROID_HOME = $androidHome
$env:ANDROID_SDK_ROOT = $androidHome

$pathsToAdd = @(
    (Join-Path $androidHome "platform-tools"),
    (Join-Path $androidHome "emulator"),
    (Join-Path $androidHome "cmdline-tools\latest\bin")
)

$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = if ($currentUserPath) { $currentUserPath -split ";" | Where-Object { $_ -ne "" } } else { @() }

foreach ($p in $pathsToAdd) {
    if ($pathParts -notcontains $p) {
        $pathParts += $p
        Write-Host "Added to User PATH: $p" -ForegroundColor Green
    }
    if (($env:Path -split ";") -notcontains $p) {
        $env:Path = "$env:Path;$p"
    }
}

[Environment]::SetEnvironmentVariable("Path", ($pathParts -join ";"), "User")

Write-Host "`n=== 4. Checking Android SDK & ADB ===" -ForegroundColor Cyan
Write-Host "ANDROID_HOME is set to: $env:ANDROID_HOME"
if (Test-Path (Join-Path $androidHome "platform-tools\adb.exe")) {
    adb version
} else {
    Write-Host "adb.exe not found yet. Open Android Studio -> SDK Manager to download Android SDK Platform, Build-Tools, and Platform-Tools." -ForegroundColor Yellow
}

Write-Host "`n=== 5. Detecting Current Project Type ===" -ForegroundColor Cyan
if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw
    if ($pkg -match '"expo"') {
        Write-Host "Expo project detected. Run: npx expo start" -ForegroundColor Green
    } elseif (Test-Path "android") {
        Write-Host "React Native CLI project (android/ folder found). Run: npx react-native run-android" -ForegroundColor Green
    } else {
        Write-Host "package.json found, but no 'android/' folder or 'expo' dependency detected yet." -ForegroundColor Yellow
    }
} else {
    Write-Host "No package.json in current directory. cd into your project folder first." -ForegroundColor Yellow
}
