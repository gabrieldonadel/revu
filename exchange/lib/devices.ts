// Device registrations for pushes (LLP 0009): APNs token → GitHub login,
// kept in the deployment's SQLite-less world as a JSON blob in an EAS KV?
// Not yet: EAS Hosting routes are stateless, so the registry lives in
// Upstash Redis when REDIS_URL/REDIS_TOKEN are set, else in process memory
// (fine for one deployment instance during development).
export interface Device {
  token: string;
  login: string; // GitHub login the device belongs to
  bundle: string;
  updatedAt: string;
}

const memory = new Map<string, Device>();

async function redis(command: unknown[]): Promise<unknown> {
  const url = process.env.REDIS_URL;
  const auth = process.env.REDIS_TOKEN;
  if (!url || !auth) return undefined;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result;
}

export async function register(device: Device): Promise<void> {
  memory.set(device.token, device);
  await redis(['HSET', 'revu:devices', device.token, JSON.stringify(device)]);
  await redis(['SADD', `revu:login:${device.login.toLowerCase()}`, device.token]);
}

export async function forget(token: string): Promise<void> {
  const d = memory.get(token);
  memory.delete(token);
  await redis(['HDEL', 'revu:devices', token]);
  if (d) await redis(['SREM', `revu:login:${d.login.toLowerCase()}`, token]);
}

export async function devicesFor(login: string): Promise<Device[]> {
  const fromRedis = (await redis(['SMEMBERS', `revu:login:${login.toLowerCase()}`])) as string[] | undefined;
  if (fromRedis) {
    const out: Device[] = [];
    for (const token of fromRedis) {
      const raw = (await redis(['HGET', 'revu:devices', token])) as string | null;
      if (raw) out.push(JSON.parse(raw) as Device);
    }
    return out;
  }
  return [...memory.values()].filter((d) => d.login.toLowerCase() === login.toLowerCase());
}
