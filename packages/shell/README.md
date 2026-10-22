# Teaching Hub store shell

The Capacitor project that puts the web app in the Apple App Store and Google Play (project prd
5.2.1–5.2.5; docs/project/tdd.md decision 4.3). It contains **no product logic**: the native
projects load the live site over `server.url`, so a feature release reaches the installed app the
moment it is deployed, with no store review (5.2.4). The web app is server-rendered Next.js with
API routes, which is why nothing is bundled — `www/` holds one explanatory page and nothing else.

| Setting            | Value                                                                                   | Where                                                  |
| :----------------- | :-------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| App id / bundle id | `com.indepthwebsolutions.teachinghub`                                                   | capacitor.config.ts, both native projects              |
| Name               | Teaching Hub                                                                            | capacitor.config.ts, both native projects              |
| Server origin      | `https://thp.indepthwebsolutions.com`                                                   | capacitor.config.ts (`THP_SHELL_SERVER_URL` overrides) |
| Capacitor          | 8.5.3 (core, cli, android, ios — pinned exactly)                                        | package.json                                           |
| Android            | targetSdk 36, compileSdk 36, minSdk 24, versionCode 1, AGP 8.13, Gradle 8.14.3, Java 21 | android/variables.gradle, android/app/build.gradle     |
| iOS                | deployment target 15.0, Swift Package Manager, version 1.0 (1)                          | ios/App/App.xcodeproj                                  |

## How the shell behaves

- **Only the app's origin renders in the WebView.** `capacitor.config.ts` sets no `allowNavigation`,
  so a link to any other host opens in the system browser, where the member has a URL bar and a
  way back.
- **Android back button** keeps Capacitor's default: it walks the WebView's history and leaves
  the app from the first page. The status bar keeps the system default.
- **The web app can tell it is inside the shell** through `shellPlatform()` in
  `packages/web/src/client/platform.ts`, which reads the `Capacitor` bridge the shell injects.
  No custom user agent is set; the server sees an ordinary mobile browser.
- **Deep links.** Every `https://thp.indepthwebsolutions.com/...` link opens the installed app
  (Android App Links, iOS universal links). The paths that must work are `/accept-invitation`
  and `/reset-password` and their children, because they arrive by email; claiming the whole
  origin covers them and shared recording links alike. See *Deep-link placeholders* below:
  neither platform verifies the association until the placeholders are filled.

## Building the Android bundle (works on Windows)

Prerequisites, none of which are in this repository:

- JDK 21, named in `JAVA_HOME`. Gradle 8.14 refuses to run on anything newer, and the `jbr/`
  runtime bundled with Android Studio 2026.2 is Java 25 — the build then fails with "Unsupported
  class file major version 69". Android Studio downloads a JDK 21 to `~/.jdks/` when a project
  asks for one (Settings, Build Tools, Gradle, Gradle JDK); otherwise install Temurin 21.
- Android SDK with platform 36 and build-tools 36. Android Studio's SDK Manager installs them.
  Set `ANDROID_HOME`, or write `sdk.dir=...` to `android/local.properties` (gitignored).

Then, from the repository root (`npm install` has already put the Capacitor CLI in place):

```sh
npm --workspace @thp/shell run sync:android      # regenerates android/app/src/main/assets/capacitor.config.json
cd packages/shell/android
./gradlew bundleRelease                          # gradlew.bat on a plain Windows shell
```

The bundle lands at `android/app/build/outputs/bundle/release/app-release.aab`. It is unsigned:
Play requires upload signing, so either add a `signingConfigs.release` block to
`android/app/build.gradle` with a keystore that stays **out of git**, or sign the `.aab` with
`jarsigner` before upload. `./gradlew assembleDebug` produces an installable debug APK for a device
or an emulator; `npm --workspace @thp/shell run open:android` opens the project in Android Studio.

`versionCode` in `android/app/build.gradle` must go up by one for every Play upload.

## Pointing the shell at a local server

`THP_SHELL_SERVER_URL` is read when the native projects are synced, not when the app runs, because
Capacitor bakes the config into each project's `capacitor.config.json`:

```sh
THP_SHELL_SERVER_URL=http://192.168.1.10:3000 npm --workspace @thp/shell run sync:android
cd packages/shell/android && ./gradlew installDebug
```

- Use the machine's LAN address, not `localhost`: inside the app, `localhost` is the phone.
- An `http://` URL switches on `server.cleartext` automatically; an `https://` URL leaves it off.
  Production builds therefore stay HTTPS-only as long as the variable is unset.
- Start the dev server with `NEXT_PUBLIC_API_ORIGIN` set to the same LAN origin. The client calls
  an absolute API origin and has no same-host fallback by design
  (packages/web/src/client/config.ts). Next's dev server may also need the LAN host in
  `allowedDevOrigins` before it serves its own `/_next` assets to a non-localhost host; that is a
  development-only setting and is not committed here.
- Run `npm --workspace @thp/shell run sync` with the variable unset before building anything
  that leaves your machine. The generated `capacitor.config.json` files are gitignored, so a
  stale override cannot be committed, but it can be shipped.

## iOS: what still needs a Mac

`npx cap add ios` ran on Windows without refusing (Capacitor 8 uses Swift Package Manager, so
there is no CocoaPods step), and the generated project is committed under `ios/`. Two
capabilities were added by hand because Xcode is not available here, and **nothing under `ios/`
has been compiled or signed**:

- Background Modes, Audio: `UIBackgroundModes` = `audio` in `ios/App/App/Info.plist`, so a
  teaching keeps playing when the phone locks (tdd § 2.1).
- Associated Domains: `applinks:thp.indepthwebsolutions.com` in `ios/App/App/App.entitlements`,
  referenced by `CODE_SIGN_ENTITLEMENTS` in the Xcode project.

On a Mac with Xcode 26 (Capacitor 8's minimum) and the repository cloned:

```sh
npm install
npm --workspace @thp/shell run sync
npm --workspace @thp/shell run open:ios          # opens ios/App/App.xcodeproj in Xcode
```

In Xcode, select the **App** target, then **Signing & Capabilities**:

1. Pick the team. Automatic signing registers the bundle id and the capabilities below with the
   developer portal.
2. Confirm **Background Modes** is listed with **Audio, AirPlay, and Picture in Picture** ticked.
   If the capability is missing from the tab, press **+ Capability** and add it; Xcode reuses the
   Info.plist entry.
3. Confirm **Associated Domains** is listed with `applinks:thp.indepthwebsolutions.com`. If it is
   missing, press **+ Capability**, choose Associated Domains, and add the entry; Xcode reuses
   `App.entitlements`.
4. Build once for a simulator (Cmd-B) to resolve the Swift package, then **Product, Archive** and
   upload through Organizer for TestFlight or review.

Or from the command line once signing is configured in Xcode:

```sh
cd packages/shell/ios/App
xcodebuild -resolvePackageDependencies -project App.xcodeproj -scheme App
xcodebuild -project App.xcodeproj -scheme App -configuration Release -destination "generic/platform=iOS" archive -archivePath build/App.xcarchive
xcodebuild -exportArchive -archivePath build/App.xcarchive -exportPath build -exportOptionsPlist ExportOptions.plist
```

Universal links also need the Team ID in the association file (next section). iOS fetches it
from the site when the app is installed, so deploy the web app with the real value before testing
a link.

## Deep-link placeholders (operator action)

Two files under `packages/web/public/.well-known/` carry values only the operator has:

| File                         | Placeholder                               | Replace with                                                                                                                                                                                                                                                                                                                                                                                             |
| :--------------------------- | :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apple-app-site-association` | `APPLE_TEAM_ID_PLACEHOLDER`               | The 10-character Team ID from https://developer.apple.com/account under Membership details. The value becomes `TEAMID.com.indepthwebsolutions.teachinghub`.                                                                                                                                                                                                                                                 |
| `assetlinks.json`            | `ANDROID_SIGNING_CERT_SHA256_PLACEHOLDER` | The SHA-256 of the certificate that signs what members install. With Play App Signing that is Play's key: Play Console, Setup, App signing, *App signing key certificate*, SHA-256. For a locally signed debug build, run `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android` and add its SHA-256 as a second array entry. Colon-separated upper-case hex, as both tools print it. |

Both files are served by Next from `public/`. `apple-app-site-association` has no extension, and
Apple refuses anything not typed `application/json`, so `packages/web/next.config.ts` carries a
header rule for that path; `assetlinks.json` is typed by its extension. After deploying, check:

```sh
curl -sI https://thp.indepthwebsolutions.com/.well-known/apple-app-site-association | grep -i content-type
curl -s  https://thp.indepthwebsolutions.com/.well-known/assetlinks.json
```

Android verifies on install and can be re-run with
`adb shell pm verify-app-links --re-verify com.indepthwebsolutions.teachinghub`. Apple's CDN
caches the association file, so a change can take a few hours to reach devices.

## What is not done in this package

- No app icons or splash screens beyond Capacitor's defaults (prd 5.2.3 is a later ticket).
- No push notifications (5.2.5), no background-audio plumbing beyond the iOS capability, and no
  download storage. The shell stays empty of product logic by design; those tickets add plugins
  here and read `shellPlatform()` in the web app.
- Nothing in this package has been compiled: the machine it was generated on has no JDK, Android
  SDK or Xcode.
