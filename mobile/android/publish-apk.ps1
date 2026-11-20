# Publishes the signed Android app on our own server (no store): copies the release APK into frontend\public\app and writes
# frontend\public\app\android.json (read by the app's update check and the /get-app page). Takes effect with the next
# website build (`npm run build` in frontend publishes frontend\dist).
#   1. Raise versionCode / versionName in app\build.gradle.kts for every release.
#   2. .\gradlew.bat :app:testReleaseUnitTest :app:lintRelease :app:assembleRelease
#   3. .\publish-apk.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$apk = Join-Path $here 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "No release APK at $apk - build it first." }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'C:\Android\sdk' }
# The machine-wide JAVA_HOME may point at a removed JDK: use one that exists (the build uses the same).
if (-not ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe')))) {
    $java = (Get-Command java -ErrorAction SilentlyContinue).Source
    if ($java) { $env:JAVA_HOME = Split-Path (Split-Path $java) }
}
$bt = Get-ChildItem (Join-Path $sdk 'build-tools') | Sort-Object Name -Descending | Select-Object -First 1

# Refuse an unsigned / wrongly signed APK.
$verify = & (Join-Path $bt.FullName 'apksigner.bat') verify --print-certs $apk 2>&1
if ($LASTEXITCODE -ne 0) { throw "APK signature check failed:`n$verify" }
if (-not ($verify -match 'CN=OneInsure Connect')) { throw "APK is not signed with the OneInsure Connect key." }

$badging = & (Join-Path $bt.FullName 'aapt2.exe') dump badging $apk 2>&1 | Select-Object -First 1
if ($badging -notmatch "versionCode='(\d+)' versionName='([^']+)'") { throw "Cannot read the version from the APK." }
$code = [int]$Matches[1]; $name = $Matches[2]

$out = Join-Path $here '..\..\frontend\public\app'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $apk (Join-Path $out 'OneInsureConnect.apk') -Force
$file = Get-Item (Join-Path $out 'OneInsureConnect.apk')
$info = [ordered]@{
    versionCode = $code
    versionName = $name
    url         = 'https://www.oneinsure.com/meet/app/OneInsureConnect.apk'
    sizeMb      = [math]::Round($file.Length / 1MB, 1)
    sha256      = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    minAndroid  = '8'
    released    = (Get-Date -Format 'yyyy-MM-dd')
}
($info | ConvertTo-Json) | Set-Content (Join-Path $out 'android.json') -Encoding ascii
"Published $name (code $code), $($info.sizeMb) MB, sha256 $($info.sha256)"
