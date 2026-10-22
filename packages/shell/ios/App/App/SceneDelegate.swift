import UIKit
import Capacitor

/// The shell's one scene. Capacitor's proxy handles everything a window onto the live site needs;
/// what is added is the one thing it does not do: **a universal link lands on the linked page.**
///
/// Capacitor only publishes the link for the App plugin's `appUrlOpen` event and loads
/// `server.url` regardless, so without this a verified invitation link would open the app on the
/// landing and the invitation would be lost. Done here rather than with the App plugin and a
/// listener in the web app because navigating the window is the shell's job, not product logic
/// (docs/project/tdd.md decision 4.3) — the web app sees an ordinary page load. The Android
/// activity does the same (`MainActivity.java`).
///
/// A link can arrive two ways: in `connectionOptions.userActivities` when it is what launched the
/// app, and in `continue userActivity` when the app was already running. The second replaces the
/// page, which stops a teaching that was playing; the member asked for that page.
///
/// Written on Windows and **not compiled**: the first build on a Mac is where a typo here shows.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
            openLinkedPage(activity.webpageURL)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)

        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb else { return }
        openLinkedPage(userActivity.webpageURL)
    }

    /// Loads the link into the WebView when it is on the configured origin — scheme, host and port,
    /// the browser's definition — and otherwise leaves it alone. The associated domain already
    /// limits what iOS hands over, but the origin can be overridden for a development build, and a
    /// page from anywhere else belongs in Safari.
    private func openLinkedPage(_ url: URL?) {
        guard let url = url,
              let controller = window?.rootViewController as? CAPBridgeViewController else { return }
        // On a cold start the WebView exists only once the view has loaded.
        controller.loadViewIfNeeded()
        guard let webView = controller.webView,
              let origin = controller.bridge?.config.serverURL,
              url.scheme?.lowercased() == origin.scheme?.lowercased(),
              url.host?.lowercased() == origin.host?.lowercased(),
              url.port == origin.port else { return }
        webView.load(URLRequest(url: url))
    }
}
