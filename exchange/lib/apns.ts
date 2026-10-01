// APNs over HTTP/2 with a token (JWT, ES256) from the team's auth key — the
// server half of LLP 0009. Secrets come from EAS environment variables:
// APNS_KEY (the .p8's contents), APNS_KEY_ID, APPLE_TEAM_ID. The topic is
// the app's bundle id. One push per device; a 410 means the token is gone.
import { createSign } from 'node:crypto';

const TOPIC = process.env.APNS_TOPIC ?? 'dev.donadel.revu';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let cached: { token: string; at: number } | null = null;

/** An APNs provider token, reused for 50 minutes (Apple accepts up to an hour). */
export function providerToken(): string {
  const key = process.env.APNS_KEY;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!key || !keyId || !teamId) throw new Error('APNS_KEY, APNS_KEY_ID and APPLE_TEAM_ID must be set');
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.at < 50 * 60) return cached.token;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: now }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: key.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  const token = `${header}.${claims}.${base64url(signature)}`;
  cached = { token, at: now };
  return token;
}

export interface Push {
  title: string;
  body: string;
  threadId?: string;
  data?: Record<string, string>;
}

/** Sends one push; returns the status and whether the token should be dropped. */
export async function send(deviceToken: string, push: Push, sandbox = false): Promise<{ status: number; gone: boolean; reason: string }> {
  const host = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${providerToken()}`,
      'apns-topic': TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert: { title: push.title, body: push.body }, sound: 'default', 'thread-id': push.threadId ?? 'revu', 'mutable-content': 1 },
      ...(push.data ?? {}),
    }),
  });
  const text = await res.text().catch(() => '');
  let reason = '';
  try { reason = String((JSON.parse(text) as { reason?: string }).reason ?? ''); } catch { reason = text.slice(0, 120); }
  return { status: res.status, gone: res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered', reason };
}
