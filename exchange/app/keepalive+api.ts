// The daily heartbeat (`.github/workflows/keepalive.yml`): one write and one
// read against the device registry, so the free Supabase project never goes
// 7 days without activity and is not paused. Open on purpose — it only
// rewrites its own fixed row (lib/devices.ts `heartbeat`) and answers counts.
import { heartbeat } from '../lib/devices';

export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, ...(await heartbeat()) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
