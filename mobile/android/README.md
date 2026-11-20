# OneInsure Connect — Android app

The portal (https://www.oneinsure.com/meet) in a locked-down WebView, plus what a phone browser cannot do:

- **presenting the phone screen**: a second, screen-only connection to our own video server; server side in `ScreenCompanion`;
- **keeping the call alive** while another app is open (`MeetingService`).

Free and open-source only:
- Android SDK, Gradle, AndroidX;
- LiveKit Android 2.30.0 (Apache 2.0).

It uses no store, no cloud service and no paid account. The APK is downloaded from our own server (`/meet/get-app`).

## Build (Windows, this server)

```powershell
$env:JAVA_HOME = 'C:\Program Files\OpenLogic\jdk-22.0.2.9-hotspot'   # any JDK 17-23
$env:ANDROID_HOME = 'C:\Android\sdk'                                   # SDK 35, build-tools 35
.\gradlew.bat :app:testReleaseUnitTest :app:lintRelease :app:assembleRelease
.\publish-apk.ps1        # copies the APK to frontend\public\app + writes android.json
```

The website build (`npm run build` in `frontend`) then publishes the APK at `/meet/app/OneInsureConnect.apk`.

**For every release, raise `versionCode` and `versionName`** in `app/build.gradle.kts`. The app offers the update when `android.json` has a higher `versionCode`.

## Signing key — keep it safe

The key is in `C:\Android\keys\oneinsure-connect.jks`, with its passwords in `keystore.properties` next to it. It is outside the repository and readable only by administrators.

**Back up both files** to a safe place. Without this key, phones that already have the app **cannot install updates**; everyone would have to uninstall and reinstall.

Certificate SHA-256: `b0e35fac2cba39e6c30751cd2650c1b4134904434a1747d6bd1b2374de06bc02`.

## Security

- **What runs inside the app:** only `https://www.oneinsure.com/meet/...`. Other links open in the browser. `javascript:`, `file:`, `data:` and `intent:` are blocked. HTTPS only, with system certificates only.
- **The bridge to the page** (`window.OicAndroid`, androidx.webkit `WebMessageListener`) exists only on pages from `https://www.oneinsure.com`, and only in the main frame.
- **Where the phone screen goes:** only to `wss://www.oneinsure.com/...`, with a token from our server. That token may publish only a screen; it cannot see, hear, chat or administer. It is short-lived, it is audited (`ROOM_SCREEN_APP_TOKEN_ISSUED`), and it is cut when the person is removed.
- **App data:** no backup or device transfer of app data. WebView debugging is on only in debug builds.

## Tests

- **App rules:** `app/src/test/.../UrlPolicyTest.kt` (JVM, no phone).
- **Server:** `MeetingLinkTests.Android_app_screen_companion_token_...`.
- **End to end:** `tests/e2e/room/android-app-present.mjs` simulates the app bridge plus the native publisher against the test site.
- **Real phones:** `documentation/ANDROID_APP_TEST_CHECKLIST.md`.

## iOS

iOS isn't built yet. It needs a Mac with Xcode and an Apple Developer account (about $99 per year). iPhones use the browser instead; presenting works there from iOS 27.2.
