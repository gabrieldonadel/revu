// Device registrations for pushes (LLP 0009): APNs token → GitHub login.
// EAS Hosting routes are stateless, so the registry lives in Supabase
// (Postgres over PostgREST, service-role key) when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set, else in process memory (development;
// forgotten on every deploy — the app re-registers at each launch anyway).
//
// Table (exchange/supabase/schema.sql):
//   revu_devices(token text primary key, login text not null, bundle text,
//                updated_at timestamptz) + index on lower(login)
export interface Device {
  token: string;
  login: string; // GitHub login the device belongs to
  bundle: string;
  updatedAt: string;
}

const memory = new Map<string, Device>();

function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

async function rest(path: string, init: RequestInit & { prefer?: string } = {}): Promise<unknown> {
  const sb = supabase();
  if (!sb) return undefined;
  const res = await fetch(`${sb.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`supabase ${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function register(device: Device): Promise<void> {
  memory.set(device.token, device);
  await rest('revu_devices?on_conflict=token', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify([{ token: device.token, login: device.login, bundle: device.bundle, updated_at: device.updatedAt }]),
  });
}

export async function forget(token: string): Promise<void> {
  memory.delete(token);
  await rest(`revu_devices?token=eq.${encodeURIComponent(token)}`, { method: 'DELETE', prefer: 'return=minimal' });
}

export async function devicesFor(login: string): Promise<Device[]> {
  const rows = (await rest(`revu_devices?select=token,login,bundle,updated_at&login=ilike.${encodeURIComponent(login)}`)) as Array<Record<string, string>> | undefined;
  if (rows) return rows.map((r) => ({ token: r.token!, login: r.login!, bundle: r.bundle ?? 'dev.donadel.revu', updatedAt: r.updated_at ?? '' }));
  return [...memory.values()].filter((d) => d.login.toLowerCase() === login.toLowerCase());
}

/** Which store is live, for the diagnostics route. */
export function registryKind(): string {
  return supabase() ? 'supabase' : 'memory';
}

/** The heartbeat row (`/keepalive`): a write a day keeps a free Supabase
 *  project from being paused for inactivity (Supabase pauses after 7 quiet
 *  days; 2026-10-08). Its login has underscores, which no GitHub login can,
 *  so no webhook ever matches it and no push is ever sent to its token. */
export const KEEPALIVE_TOKEN = 'revu-keepalive';
export const KEEPALIVE_LOGIN = '__revu_keepalive__';

export async function heartbeat(now = new Date().toISOString()): Promise<{ registry: string; devices: number; at: string }> {
  if (!supabase()) return { registry: 'memory', devices: memory.size, at: now };
  await rest('revu_devices?on_conflict=token', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify([{ token: KEEPALIVE_TOKEN, login: KEEPALIVE_LOGIN, bundle: 'keepalive', updated_at: now }]),
  });
  const rows = (await rest(`revu_devices?select=token&token=neq.${KEEPALIVE_TOKEN}`)) as unknown[] | undefined;
  return { registry: 'supabase', devices: rows?.length ?? 0, at: now };
}
