// @ref LLP 0000#architecture — the menu bar item is the primary surface;
// the native NSMenu is the list until the tray popover exists upstream.
import { Exact, type MenuItemConfig, type TrayHandle } from '@exact/runtime/src/desktop-platform.ts';

import { getAuthState, onAuthChange } from './auth.ts';
import { getSnapshot, onEvent, sidecar, type PullRequest } from './sidecar-client.ts';

let tray: TrayHandle | null = null;

function relativeAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function prItem(pr: PullRequest): MenuItemConfig {
  return {
    id: `pr:${pr.id}`,
    label: `${pr.seen ? '' : '● '}${pr.repo}#${pr.number} — ${pr.title}`,
    items: [
      {
        id: `open:${pr.id}`,
        label: `Open on GitHub  (${pr.author}, ${relativeAge(pr.requested_at)})`,
        action: () => void Exact.shell.openExternal(pr.url),
      },
      {
        id: `seen:${pr.id}`,
        label: pr.seen ? 'Mark unread' : 'Mark read',
        action: () => void sidecar.markSeen(pr.id, !pr.seen),
      },
      { id: `review:${pr.id}`, label: 'Run AI review…', enabled: false },
    ],
  };
}

function buildMenu(): MenuItemConfig[] {
  const auth = getAuthState();
  const snap = getSnapshot();
  const items: MenuItemConfig[] = [];

  if (!snap.connected) {
    items.push({ id: 'status', label: 'Sidecar not running', enabled: false });
  } else if (auth.phase !== 'signed_in') {
    items.push({ id: 'status', label: auth.phase === 'device_code' ? `Enter code ${auth.userCode} on GitHub` : 'Not signed in', enabled: false });
  } else if (snap.prs.length === 0) {
    items.push({ id: 'status', label: 'No pending review requests', enabled: false });
  } else {
    for (const pr of snap.prs) items.push(prItem(pr));
  }

  items.push({ type: 'separator' });
  if (auth.phase === 'signed_in') {
    items.push({ id: 'refresh', label: 'Refresh now', action: () => void sidecar.pollNow().catch(() => undefined) });
    items.push({
      id: 'poll',
      label: snap.lastPollError ? `Last poll failed: ${snap.lastPollError}` : `Last poll ${snap.lastPollAt ? relativeAge(snap.lastPollAt) + ' ago' : 'pending'}`,
      enabled: false,
    });
  }
  items.push({ id: 'window', label: 'Open revu', action: () => void Exact.app.unhide?.() });
  items.push({ type: 'separator' });
  items.push({ id: 'quit', label: 'Quit revu', role: 'quit' });
  return items;
}

function refresh(): void {
  if (!tray) return;
  const unread = getSnapshot().prs.filter((pr) => !pr.seen).length;
  // No icon asset yet: a text title keeps the status item from collapsing to zero width.
  tray.setTitle(unread > 0 ? `PR ${unread}` : 'PR');
  tray.setTooltip(unread > 0 ? `${unread} review request${unread === 1 ? '' : 's'} waiting` : 'revu — no pending reviews');
  tray.setMenu(buildMenu());
}

export async function installTray(): Promise<void> {
  if (tray) return;
  tray = await Exact.tray.create({
    tooltip: 'revu',
    template: true,
    menuOnLeftClick: true,
    menu: buildMenu(),
  });
  tray.setTitle('PR');
  onEvent(() => refresh());
  onAuthChange(() => refresh());
  refresh();
}
