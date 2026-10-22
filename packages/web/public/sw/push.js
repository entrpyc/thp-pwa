/*
 * Push notifications (PRD 3.17.1). Loaded by `/sw.js`; see its header for how modules compose.
 *
 * This is where the `push` handler that turns a server message into `showNotification`, and the
 * `notificationclick` handler that focuses or opens the hub at the notification's target, will go.
 * Both are registered now as no-ops so the core's composition, the unit test over it and the
 * installed worker's shape are already what they will be — the push ticket replaces the bodies and
 * touches no other file.
 *
 * The listeners are registered unconditionally rather than behind a feature check because a
 * browser without push never dispatches the event; an unused listener costs nothing and a
 * conditional one is a second place the feature could be switched off.
 */

self.addEventListener('push', () => {});

self.addEventListener('notificationclick', () => {});
