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
| Plugins            | `@capgo/capacitor-media-session` 8.1.5, `@capacitor/push-notifications` 8.1.3 (pinned exactly, here and in packages/web) | package.json, packages/web/package.json                |
| Android            | targetSdk 36, compileSdk 36, minSdk 24, versionCode 1, AGP 8.13, Gradle 8.14.3, Java 21 | android/variables.gradle, android/app/build.gradle     |
| iOS                | deployment target 15.0, Swift Package Manager, version 1.0 (1)                          | ios/App/App.xcodeproj                                  |

## How the shell behaves

- **Only the app's origin renders in the WebView.** `capacitor.config.ts` sets no `allowNavigation`,
  so a link to any other host opens in the system browser, where the member has a URL bar and a
  way back.
- **Android back button** keeps Capacitor's default: it walks the WebView's history and leaves
  the app from the first page. The system bars, the launch window and the offline screen are
  the product's own — see *Icons, splash screens, system bars and the offline screen* below.
- **The web app can tell it is inside the shell** through `shellPlatform()` in
  `packages/web/src/client/platform.ts`, which reads the `Capacitor` bridge the shell injects.
  No custom user agent is set; the server sees an ordinary mobile browser. Two things read it:
  - the member menu's *Install app* row (`install-app.tsx`), which treats either shell as already
    installed and offers nothing — the shell's WebView is neither standalone nor
    `navigator.standalone`, so without that reading the store app told a member to install the
    app they were in;
  - the player's media session (`packages/web/src/client/playback/shell-media-session.ts`), below.
- **Background audio and the lock screen** (project prd 3.2.6, 5.1.3; tdd § 2.1).
  - *Android.* Playback itself needs nothing: Capacitor never calls `WebView.onPause()`, so the
    page's `<audio>` keeps running when the app is backgrounded or the screen locks, and Chromium
    holds a wake lock while audible audio plays. What the WebView does **not** have is the Media
    Session API — no `navigator.mediaSession`, no `MediaMetadata` — so a lock screen with nothing
    on it is what a plain WebView gives, and the controls come from
    `@capgo/capacitor-media-session`: a native `MediaSession` behind a foreground service that
    runs for the length of a sitting (and keeps the process alive for it). The player talks to one
    object either way; inside the Android shell that object forwards to the plugin (and supplies
    the missing `MediaMetadata`), everywhere else it is `navigator.mediaSession`. The service's
    notification is exempt from
    Android 13's notification permission, so no prompt is shown. The app manifest declares
    `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, which Android 14+ requires for a `mediaPlayback` service
    and which the plugin's own manifest leaves out.
  - *iOS.* `UIBackgroundModes` = `audio` lets the WebView keep playing when the phone locks, and
    WebKit wires `navigator.mediaSession` to the lock screen itself, so the plugin is not used
    there (its iOS side is the same web implementation; two writers would fight over one screen).
    If a device shows an empty lock screen, the one condition in `shellMediaSession()` is the
    switch. If audio stops when the ringer switch is silent, add
    `try? AVAudioSession.sharedInstance().setCategory(.playback)` to `AppDelegate.swift`'s
    `didFinishLaunchingWithOptions` — WebKit normally sets the category itself, so it is not added
    blind from a machine that cannot run it.
- **Deep links.** Every `https://thp.indepthwebsolutions.com/...` link opens the installed app
  (Android App Links, iOS universal links). The paths that must work are `/accept-invitation`
  and `/reset-password` and their children, because they arrive by email; claiming the whole
  origin covers them and shared recording links alike. Capacitor itself only publishes the link
  for the App plugin's `appUrlOpen` event and loads `server.url` regardless, so each native project
  loads the linked page into the WebView itself (`MainActivity.java`, `SceneDelegate.swift`) when
  the link is on the configured origin: navigating the window is the shell's job, not the web
  app's, which sees an ordinary page load. The email links are built from `NEXT_PUBLIC_API_ORIGIN`
  (`packages/web/src/server/mail/env.ts`) and need no change: they already point at the origin
  both platforms claim. See *Deep-link values* below for what each platform verifies against.

## Push notifications (project prd 3.17.1, 5.2.5)

The shell contributes the native half of push and nothing more: `@capacitor/push-notifications`
asks the OS for permission, registers with APNs or FCM, hands the token to the web app, and
reports a press. Everything else — the switches, the registration with the server, where a press
lands — is the web app's (`packages/web/src/client/push/push-device.ts`,
`push-shell-listener.tsx`), and the sending is `packages/push`. The prompt is raised only from the
*Turn on push on this device* button on `/profile/notifications`, never at launch (Apple 5.1.2).

What this package carries for it:

- `capacitor.config.ts` — `PushNotifications.presentationOptions`, so a push arriving while the
  app is open is still shown by the OS.
- **Android** — `POST_NOTIFICATIONS` in the manifest (a runtime prompt on Android 13+). FCM needs
  `android/app/google-services.json` from the Firebase console (Project settings, your Android
  app, *Download google-services.json*); `build.gradle` already applies the Google services
  plugin when the file is present. The file is gitignored: it names the Firebase project and is a
  per-deployment artefact, not source.
- **iOS** — `aps-environment` in `App.entitlements`, and the two `AppDelegate` methods that hand
  the APNs token to the plugin. In Xcode, *Signing & Capabilities* must list **Push
  Notifications** (press *+ Capability* if it does not; Xcode reuses the entitlement). The server
  signs with the `.p8` key from the developer account (`.env.example`, `APNS_*`); nothing is
  uploaded to Firebase for iOS.

**Verifying on a device** (nothing here is covered by the automated suites):

1. Deploy the web app with the channel's credentials set (`APNS_*` for iOS, `FCM_SERVICE_ACCOUNT`
   for Android) and `PUSH_TRANSPORT=real`. For a build installed from Xcode rather than
   TestFlight, set `APNS_ENVIRONMENT=sandbox`.
2. Android: put `google-services.json` in `android/app/`, run
   `npm --workspace @thp/shell run sync:android`, build and install. iOS: run `sync`, open in
   Xcode, confirm the Push Notifications capability, build to a real device — the simulator has
   no APNs.
3. Sign in, open the member menu, *My profile*, *Notifications*. The line reads *Push is off for
   this device*. Press **Turn on push on this device**. The OS prompt appears **now and not
   before** — it must not have appeared at launch or at sign-in. Allow it. The line reads *Push
   is on for this device*; the server log shows `account.push-subscription.registered` with the
   platform.
4. Background the app (home button), then from another account reply to one of this member's
   public notes. A notification appears within seconds with the replier's name and the reply's
   first line. Tap it: the app opens on that teaching. The server log shows `push.delivered` with
   `sent: 1`.
5. Lock the phone and send an admin announcement from `/admin/announcements`: the notification
   shows on the lock screen; tapping it opens the notification centre.
6. With the app open in the foreground, send another announcement: the OS still shows it
   (presentationOptions) and the bell's count rises without a reload.
7. Switch *Announcements* off on `/profile/notifications` and send one more: nothing arrives, and
   the row is in the centre regardless. Switch it back on.
8. Sign out. The log shows `account.push-subscription.removed` with `removed: true`. Send an
   announcement: nothing arrives on this device. Sign in as a different member on the same
   device and press the button again: the device now receives that member's notices and not the
   first one's.
9. Uninstall the app, send an announcement: the log shows `push.subscriptions.removed` with
   `provider-reported-gone` on the next delivery to that device (APNs may take one more send to
   report it).
10. Android only, from a terminal: `adb shell dumpsys notification --noredact | grep -A3 teachinghub`
    lists the posted notification; `adb logcat | grep -i "PushNotifications\|FirebaseMessaging"`
    shows the token registration and each arrival.

Browser PWA: deploy with a VAPID pair (`.env.example`), open the site in Chrome, or on an iPhone
add it to the home screen first and open it from there (Safari in a tab cannot subscribe); then
steps 3 to 8 apply unchanged, and the service worker lands the press (`public/sw/push.js`).

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

The bundle lands at `android/app/build/outputs/bundle/release/app-release.aab`. It is signed with
the upload key when `android/local.properties` (gitignored) names it, and left unsigned otherwise:

```properties
sdk.dir=C:\Users\<you>\AppData\Local\Android\Sdk
thp.upload.storeFile=C:\path\outside\the\repo\upload.keystore
thp.upload.storePassword=...
thp.upload.keyAlias=upload
thp.upload.keyPassword=...
```

The same four values are read from `THP_UPLOAD_STORE_FILE`, `THP_UPLOAD_STORE_PASSWORD`,
`THP_UPLOAD_KEY_ALIAS` and `THP_UPLOAD_KEY_PASSWORD` when the file does not set them. The keystore
was generated once with `keytool -genkeypair -keyalg RSA -keysize 2048 -validity 10000` and is
**not in the repository**: it is the upload key Play App Signing trusts, so back it up with its
password, and if it is ever lost ask Play for an upload-key reset rather than making a new app.
`./gradlew assembleDebug` produces an installable debug APK for a device
or an emulator; `npm --workspace @thp/shell run open:android` opens the project in Android Studio.

`versionCode` in `android/app/build.gradle` must go up by one for every Play upload.

## Pointing the shell at a local server

`THP_SHELL_SERVER_URL` is read when the native projects are synced, not when the app runs, because
Capacitor bakes the config into each project's `capacitor.config.json`:

```sh
THP_SHELL_SERVER_URL=http://localhost:3000 npm --workspace @thp/shell run sync:android
cd packages/shell/android && ./gradlew installDebug
adb reverse tcp:3000 tcp:3000 && adb reverse tcp:9000 tcp:9000
```

- Inside the app, `localhost` is the phone — unless `adb reverse` forwards it, which is the
  easiest arrangement for an emulator or a USB device: the app, the `.env` default of
  `NEXT_PUBLIC_API_ORIGIN=http://localhost:3000` and the MinIO URLs the API signs all agree on one
  host, and nothing else needs setting. The reverse lasts until the device reconnects. Without it,
  use the machine's LAN address in both the variable and `NEXT_PUBLIC_API_ORIGIN`; the client
  calls an absolute API origin and has no same-host fallback by design
  (packages/web/src/client/config.ts), and Next's dev server may then also need the LAN host in
  `allowedDevOrigins` before it serves its own `/_next` assets — a development-only setting that
  is not committed here.
- An `http://` URL switches on `server.cleartext` automatically; an `https://` URL leaves it off.
  Production builds therefore stay HTTPS-only as long as the variable is unset.
- Run `npm --workspace @thp/shell run sync` with the variable unset before building anything
  that leaves your machine. The generated `capacitor.config.json` files are gitignored, so a
  stale override cannot be committed, but it can be shipped.

## iOS: what still needs a Mac

`npx cap add ios` ran on Windows without refusing (Capacitor 8 uses Swift Package Manager, so
there is no CocoaPods step), and the generated project is committed under `ios/`. Two
capabilities and one piece of Swift were added by hand because Xcode is not available here, and
**nothing under `ios/` has been compiled or signed**:

- Background Modes, Audio: `UIBackgroundModes` = `audio` in `ios/App/App/Info.plist`, so a
  teaching keeps playing when the phone locks (tdd § 2.1).
- Associated Domains: `applinks:thp.indepthwebsolutions.com` in `ios/App/App/App.entitlements`,
  referenced by `CODE_SIGN_ENTITLEMENTS` in the Xcode project.
- `SceneDelegate.swift` loads a universal link into the WebView (see *Deep links* above). It is
  short and uses only `CAPBridgeViewController.webView` and `bridge.config.serverURL`, both public
  in Capacitor 8.5, but the first Mac build is where a typo would show.

`npm --workspace @thp/shell run sync` also adds the media-session plugin to the Swift package
(`ios/App/CapApp-SPM/Package.swift`); the web app does not call it on iOS, and it adds no
capability or Info.plist entry.

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

## Deep-link values (operator action)

Two files under `packages/web/public/.well-known/` name the apps allowed to open the site's
links. Each platform fetches its file **from the live site** when the app is installed, so a
value only takes effect once the web app is deployed with it.

| File                         | Entry                                     | Status and where the value comes from                                                                                                                                                                                                                                                                                                                                                                                                      |
| :--------------------------- | :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apple-app-site-association` | `B2PZ326S78`                              | **Set.** The 10-character Team ID from https://developer.apple.com/account under Membership details, or `xcrun security find-identity -v -p codesigning` on a Mac that holds the signing certificate (the ID is in parentheses). The value becomes `TEAMID.com.indepthwebsolutions.teachinghub`.                                                                                                                                 |
| `assetlinks.json`            | `75:16:1E:41:…:40:68`                     | **Set** to the Play App Signing certificate. The SHA-256 of the certificate that signs what members install. With Play App Signing that is Play's key: Play Console, Setup, App signing, *App signing key certificate*, SHA-256. For an upload key or a local release keystore: `keytool -list -v -keystore <release.keystore> -alias <alias>`. Colon-separated upper-case hex, as both tools print it.                                                            |
| `assetlinks.json`            | *(debug keystore)*                        | **Removed.** The debug keystore's fingerprint used to sit beside the placeholder so a local `assembleDebug` build opened links; it was removed before the first store submission because the debug key is unprotected and any APK signed with it could claim the site's links. To test links from a debug build, add that machine's fingerprint (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`) locally and do not commit it. |

Both files are served by Next from `public/`. `apple-app-site-association` has no extension, and
Apple refuses anything not typed `application/json`, so `packages/web/next.config.ts` carries a
header rule for that path; `assetlinks.json` is typed by its extension. After deploying, check:

```sh
curl -sI https://thp.indepthwebsolutions.com/.well-known/apple-app-site-association | grep -i content-type
curl -s  https://thp.indepthwebsolutions.com/.well-known/assetlinks.json
```

Android verifies on install and can be re-run with
`adb shell pm verify-app-links --re-verify com.indepthwebsolutions.teachinghub`; the result is
under `adb shell pm get-app-links com.indepthwebsolutions.teachinghub` (`verified`, or
`legacy_failure` while the file still lacks the build's fingerprint). Until it verifies, Android
still opens the link in the app when the member picks it from the chooser, or when a test sends it
to the package by name (checklist below). Apple's CDN caches the association file, so a change
can take a few hours to reach devices.

## Manual verification checklist

Run on a build pointed at the live site unless the step says otherwise. Each line is a thing a
member would notice; the automated suites cannot see any of them.

**Both platforms**

1. **No install prompt.** Sign in, open the member menu. There must be no *Install app* row —
   not the Android prompt, not the iOS "tap Share" steps. (In a browser tab on the same phone the
   row is still there.)
2. **Background play.** Open a teaching, press play, press the home button. Sound continues.
   Lock the phone. Sound continues for at least five minutes.
3. **Lock-screen controls.** With the phone locked, the lock screen (Android: also the
   notification shade) names the teaching and its series and shows the series cover. Pause from
   there, then play; skip back and forward move ten seconds, the same as the bar. Scrub on the
   lock screen where it offers a scrubber. Unlock: the bar agrees with what the lock screen did.
4. **Stop from the lock screen** (Android: swipe the notification away; iOS: there is no stop)
   leaves the teaching loaded in the bar, paused, at its position.
5. **Link opening.** From the phone's mail app or a notes app, tap an invitation link and a
   reset link. Each opens the shell, not the browser, on that page. Tap one while a teaching is
   playing: the page is replaced and playback stops, which is the documented behaviour.
6. **Other origins stay out.** A link to any other host from inside the app opens the system
   browser.
7. **Offline screen.** Turn on aeroplane mode, force-quit the app and open it. The product's own
   "You're offline" page shows, not a browser error. Turn aeroplane mode off: the page loads the
   app on its own within a few seconds. With the network on but the server stopped (a build
   pointed at a local dev server), the page says the server could not be reached.
8. **Icon, splash and system bars.** The launcher and home screen show the purple play mark on
   the dark background, not Capacitor's logo. The launch window is the same dark colour with the
   mark. Once loaded, the status bar icons are light and the top bar sits below them; the
   transport bar clears the gesture area or home indicator with no dark band between.

**Android, from a terminal**

```sh
adb shell pm get-app-links com.indepthwebsolutions.teachinghub                 # Domain verification state: verified
adb shell am start -a android.intent.action.VIEW -d "https://thp.indepthwebsolutions.com/reset-password?token=test" com.indepthwebsolutions.teachinghub
adb shell dumpsys media_session | grep -A6 "package=com.indepthwebsolutions"   # state=PLAYING, metadata names the teaching
adb shell dumpsys activity services com.indepthwebsolutions.teachinghub | grep -i "isForeground"
adb shell cmd media_session dispatch pause        # then play, rewind, fast-forward, stop — the bar follows each
adb shell input keyevent KEYCODE_SLEEP            # lock; sound continues, and the session stays PLAYING
```

(`input keyevent KEYCODE_MEDIA_PAUSE` is **not** a test of this: injected key events do not reach a
media session the way a lock screen's buttons do, and the shell appears to ignore them.)

**What was verified on 22 October 2026, and how**

On a Medium Phone emulator, Android API 37 (x86_64, Google Play image), with a debug APK built here
(`./gradlew assembleDebug`, JDK 21, Capacitor 8.5.3, plugin 8.1.5):

- *Build pointed at the live site.* `am start … VIEW` with a `/reset-password?token=…` link
  cold-started the app and the WebView's page (read over `adb forward … webview_devtools_remote_<pid>`
  and `curl localhost:9222/json`) was that URL, not the landing; a second link
  (`/accept-invitation?token=…`) sent to the running app replaced the page in the same process.
  `pm get-app-links` reported `1024` (legacy failure), as expected while the live `assetlinks.json`
  still lacks the fingerprint; the install's own signature matched the entry added here.
- *Build pointed at a local dev server* (`THP_SHELL_SERVER_URL=http://localhost:3000`, `adb
  reverse` for 3000 and 9000), signed in as the seed admin: the member menu listed no *Install
  app* row; the native session was `PLAYING` with the teaching's title, the series as artist and
  the cover as the large icon; the foreground service ran typed `mediaPlayback` with a
  `transport` notification and four actions; `currentTime` kept advancing with the app behind HOME
  for 10 s and with the screen off (`mWakefulness=Asleep`) for 25 s; `cmd media_session dispatch`
  `pause`, `play`, `rewind`, `fast-forward` and `stop` each did to the element what the bar's own
  button does, and the bar agreed afterwards. No `SecurityException` and no plugin error in logcat.
- *Not verified here:* anything on iOS (no Mac); Android App Link **verification** itself, which
  needs the fingerprint deployed; a real lock screen's drawing of the notification (the emulator's
  keyguard is off — the shade was checked instead); more than 25 s locked; a physical device;
  a release-signed build.

One pre-existing console error shows on every launch, with or without these changes:
`Uncaught TypeError: Cannot read properties of undefined (reading 'triggerEvent')` from Capacitor's
injected bridge script. It does not affect any item above and is not addressed here.

**iOS, on a Mac**

- Associated domains need the Team ID deployed first (table above); then install from Xcode and
  tap a link in Notes. A link that opens Safari means the association file is stale or wrong:
  `swcutil` output in Console.app, or the *Associated Domains* diagnostics under Settings,
  Developer, say which.
- Run with Xcode attached and lock the phone: the debugger shows the app still running and no
  `AVAudioSession` errors in the console while sound continues.

## Icons, splash screens, system bars and the offline screen

- **Icons and splash screens** are generated from the web app's own mark by
  `npm --workspace @thp/shell run assets` (`tools/generate-assets.mjs`): the Android launcher
  icons at every density (legacy, round and the adaptive foreground over `ic_launcher_background`),
  the Android splash drawables, the 1024 px iOS icon and the three iOS launch images. The
  background is `APP_BACKGROUND_COLOUR` read from `packages/web/src/app/app-theme.ts`. To change
  the art, replace `packages/web/public/icons/icon-512.png` and run the script; nothing is drawn by
  hand here. Android 12+ draws its own splash — the launcher icon on `windowSplashScreenBackground`
  (styles.xml) — and the drawables serve Android 11 and earlier; iOS shows `Splash.imageset`
  through LaunchScreen.storyboard on a background of the same colour.
- **System bars.** Android paints the status and navigation bars in the document background with
  light icons on Android 14 and earlier (styles.xml); on Android 15+, which an app targeting API
  36 draws edge-to-edge, the bars are transparent and the WebView follows the document's
  `viewport-fit=cover`, so `env(safe-area-inset-*)` carries the bar heights and the web app's own
  padding keeps the top bar and the transport bar clear (capacitor.config.ts, `SystemBars`). iOS
  shows a light status bar over the dark document (Info.plist, `UIStatusBarStyle`), and WebKit
  fills the same insets from the notch and the home indicator.
- **The offline screen.** `www/offline.html` is what `server.errorPath` shows when the origin
  cannot be loaded — no network, a captive portal, the server down — instead of the WebView's own
  error page. It is styled like the product, says whether it is the network or the server that is
  unreachable, retries on a press, and retries on its own when the device reports connectivity
  (`online`). Its retry navigates to the origin named in its `data-origin`, which
  `tools/write-offline-origin.mjs` rewrites from `THP_SHELL_SERVER_URL` before every `cap sync`
  (the `sync` scripts), so a build against a development server retries against that server.

## What is not done in this package

- No download storage. The shell stays empty of product logic by design; that ticket adds a
  plugin here and reads `shellPlatform()` in the web app, as push did.
- Push has not been exercised on a device from this machine: there is no Mac for iOS, and the
  Android build needs a Firebase project's `google-services.json` that is not in the repository.
  The checklist above is what to run once both exist.
- Nothing under `ios/` has been compiled: there is no Mac in the loop yet.
