// @ref LLP 0003 — new review requests raise a native notification with Open
// and Mark read; expo/exact LLP 0570 provides the host.
import { Exact } from '@exact/runtime/src/desktop-platform.ts';

import { onEvent, sidecar, type PullRequest } from './sidecar-client.ts';

let installed = false;

export async function installNotifications(): Promise<void> {
  if (installed) return;
  installed = true;

  // Ask once, up front (LLP 0003 consequence). On a host without the
  // notification bridge this resolves 'granted' via the web-tier fallback,
  // which is harmless: send() then simply does nothing visible.
  const permission = await Exact.notifications.requestPermission().catch(() => 'denied' as const);
  console.info(`[revu] notification permission: ${permission}`);

  Exact.notifications.on('action', (event) => {
    const pr = event.data as PullRequest | undefined;
    if (!pr) return;
    if (event.actionId === 'open' || event.actionId === 'default') {
      void Exact.shell.openExternal(pr.url);
      void sidecar.markSeen(pr.id, true);
    } else if (event.actionId === 'seen') {
      void sidecar.markSeen(pr.id, true);
    }
  });

  onEvent((event) => {
    if (event.type !== 'review_requested') return;
    void Exact.notifications
      .send({
        title: `Review requested: ${event.pr.repo}#${event.pr.number}`,
        subtitle: event.pr.author,
        body: event.pr.title,
        sound: 'default',
        actions: [
          { id: 'open', title: 'Open' },
          { id: 'seen', title: 'Mark read' },
        ],
        data: event.pr,
      })
      .catch((error) => console.warn('[revu] notification failed', error));
  });
}
