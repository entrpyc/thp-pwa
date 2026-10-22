package com.indepthwebsolutions.teachinghub;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * The shell's one activity. Capacitor's BridgeActivity does everything a window onto the live site
 * needs; what is added here is the one thing it does not do on its own, and a note on the thing it
 * does without being asked.
 *
 * <p><b>Background audio needs nothing from this class, and that is worth writing down.</b>
 * Capacitor never calls {@code WebView.onPause()} — {@code Bridge.onPause} only notifies plugins —
 * so the page's {@code <audio>} keeps running when the activity is paused or the screen locks, and
 * Chromium holds a wake lock for as long as audible audio plays. The lock-screen controls are the
 * media-session plugin's ({@code @capgo/capacitor-media-session}, declared in the shell's
 * package.json and registered by {@code cap sync}): it runs a foreground service for the length of
 * a sitting, which is also what keeps this process off the list of background work the system
 * sheds first. Verified on an emulator; packages/shell/README.md records how.
 *
 * <p><b>A deep link lands on the linked page.</b> Capacitor stores the intent's URL for the App
 * plugin's {@code appUrlOpen} event and loads {@code server.url} regardless, so without this a
 * verified invitation link would open the app on the landing and the invitation would be lost.
 * Done here rather than with the App plugin and a listener in the web app because navigating the
 * window is the shell's job, not product logic (docs/project/tdd.md decision 4.3): the web app sees
 * an ordinary page load, exactly as it would in a browser.
 *
 * <p>Only a URL on the configured origin is loaded. The intent filter already limits what Android
 * sends here, but the origin can be overridden for a development build, and a page from anywhere
 * else belongs in the system browser, as the absence of {@code allowNavigation} intends.
 *
 * <p>BridgeActivity calls {@link #onNewIntent} itself with the launch intent once the bridge
 * exists, and Android calls it for a link that arrives while the app is running
 * ({@code singleTask}), so one override covers a cold start and a warm one. The warm case replaces
 * the page, which stops a teaching that was playing: a member who taps a reset or invitation link
 * mid-sitting has asked for that page, and the position was written at the last progress tick.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openLinkedPage(intent);
    }

    private void openLinkedPage(Intent intent) {
        Bridge bridge = getBridge();
        if (bridge == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri link = intent.getData();
        String serverUrl = bridge.getServerUrl();
        if (link == null || serverUrl == null || !sameOrigin(link, Uri.parse(serverUrl))) {
            return;
        }
        bridge.getWebView().loadUrl(link.toString());
    }

    /** Scheme, host and port — the browser's definition, so what counts as "the site" matches. */
    private static boolean sameOrigin(Uri a, Uri b) {
        return a.getScheme() != null
            && a.getScheme().equalsIgnoreCase(b.getScheme())
            && a.getHost() != null
            && a.getHost().equalsIgnoreCase(b.getHost())
            && a.getPort() == b.getPort();
    }
}
