// The Mac registers its APNs token with the GitHub login it signed in as
// (LLP 0009). The app proves the login by sending its GitHub token once;
// the route asks GitHub who that is and never stores the token.
import { forget, register } from '../lib/devices';

export async function POST(request: Request): Promise<Response> {
  let body: { token?: string; github_token?: string; bundle?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: 'a JSON body is required' }, { status: 400 }); }
  if (!body.token || !body.github_token) return Response.json({ error: 'token and github_token are required' }, { status: 400 });
  const me = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${body.github_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'revu-exchange' } });
  if (!me.ok) return Response.json({ error: 'GitHub did not accept the token' }, { status: 401 });
  const login = String(((await me.json()) as { login?: string }).login ?? '');
  if (!login) return Response.json({ error: 'no login' }, { status: 401 });
  await register({ token: body.token, login, bundle: body.bundle ?? 'dev.donadel.revu', updatedAt: new Date().toISOString() });
  return Response.json({ ok: true, login });
}

export async function DELETE(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return Response.json({ error: 'token is required' }, { status: 400 });
  await forget(token);
  return Response.json({ ok: true });
}
