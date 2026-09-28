// Native boot for revu: sidecar connection, session restore, tray, notifications.
// Called once from main.native.tsx after the router mounts.
import { restoreSession } from './auth.ts';
import { installNotifications } from './notify.ts';
import { connect } from './sidecar-client.ts';
import { installTray } from './tray.ts';

let booted = false;

export function bootRevu(): void {
  if (booted) return;
  booted = true;
  connect();
  void installTray().catch((error) => console.warn('[revu] tray failed', error));
  void installNotifications().catch((error) => console.warn('[revu] notifications failed', error));
  void restoreSession();
}
