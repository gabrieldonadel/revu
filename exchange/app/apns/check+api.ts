// A diagnostic for the APNs path from this runtime (LLP 0009): sends to an
// all-zero device token and reports Apple's answer. `BadDeviceToken` means
// the provider token, topic and HTTP/2 transport all work; anything else
// names what does not. Guarded by the webhook secret so it is not public.
import { createHmac } from 'node:crypto';
import { send } from '../../lib/apns';

export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!process.env.GITHUB_WEBHOOK_SECRET || key !== process.env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: 'forbidden' }, { status: 403 });
  // `hmac=<text>`: the signature this runtime computes for that text, to
  // compare with a sender's — a webhook mismatch is then explained here.
  const probe = new URL(request.url).searchParams.get('hmac');
  if (probe !== null) {
    try {
      const mac = createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(probe).digest('hex');
      return Response.json({ hmac: `sha256=${mac}`, secretLength: process.env.GITHUB_WEBHOOK_SECRET!.length });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  }
  try {
    const r = await send('0'.repeat(64), { title: 'revu', body: 'transport check' });
    return Response.json({ ok: r.reason === 'BadDeviceToken', apple: r });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
