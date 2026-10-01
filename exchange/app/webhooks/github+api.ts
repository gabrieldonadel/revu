// The GitHub App's webhook (LLP 0009): `pull_request` with action
// `review_requested` → one push to each device of the requested user (or of
// every member we know of a requested team, by login match later). The
// signature is checked against GITHUB_WEBHOOK_SECRET before anything is read.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { devicesFor, forget } from '../../lib/devices';
import { send } from '../../lib/apns';

function verify(raw: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (!verify(raw, request.headers.get('x-hub-signature-256'))) return Response.json({ error: 'bad signature' }, { status: 401 });
  const event = request.headers.get('x-github-event');
  if (event === 'ping') return Response.json({ ok: true, pong: true });
  if (event !== 'pull_request') return Response.json({ ok: true, ignored: event });
  const payload = JSON.parse(raw) as Record<string, any>;
  if (payload.action !== 'review_requested') return Response.json({ ok: true, ignored: payload.action });
  const login = String(payload.requested_reviewer?.login ?? '');
  const team = String(payload.requested_team?.slug ?? '');
  const pr = payload.pull_request ?? {};
  const repo = String(payload.repository?.full_name ?? '');
  const number = Number(pr.number ?? 0);
  if (!login) return Response.json({ ok: true, ignored: `team request (${team}); team fan-out is not built yet` });
  const devices = await devicesFor(login);
  const results: Array<{ status: number; reason: string }> = [];
  for (const d of devices) {
    const r = await send(d.token, {
      title: `Review requested: ${repo}#${number}`,
      body: String(pr.title ?? ''),
      threadId: `${repo}#${number}`,
      data: { prId: `${repo}#${number}`, url: String(pr.html_url ?? ''), author: String(pr.user?.login ?? ''), kind: 'review_requested' },
    }, process.env.APNS_SANDBOX === '1');
    if (r.gone) await forget(d.token);
    results.push({ status: r.status, reason: r.reason });
  }
  return Response.json({ ok: true, login, devices: devices.length, results });
}

export function GET(): Response {
  return Response.json({ ok: true, service: 'revu-webhooks' });
}
