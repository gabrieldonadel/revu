// @ref LLP 0002 r4 — the one thing a desktop app cannot do itself on GitHub:
// exchange an OAuth code for a token, because GitHub requires the client
// secret at that step (PKCE is additional, not a substitute). This route runs
// on EAS Hosting with GITHUB_CLIENT_SECRET as an EAS environment variable.
// It takes {code, code_verifier, redirect_uri}, answers {access_token}, and
// keeps nothing.
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Ov23li3weoDK9jZ4ycnp';

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!secret) return Response.json({ error: 'GITHUB_CLIENT_SECRET is not set on this deployment' }, { status: 500 });
  let body: { code?: string; code_verifier?: string; redirect_uri?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'a JSON body is required' }, { status: 400 });
  }
  if (!body.code || !body.redirect_uri) return Response.json({ error: 'code and redirect_uri are required' }, { status: 400 });
  // Only revu's own loopback callback may be exchanged here.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(body.redirect_uri)) return Response.json({ error: 'redirect_uri is not revu\'s' }, { status: 400 });
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: secret, code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) return Response.json({ error: data.error_description ?? data.error ?? `GitHub answered ${res.status}` }, { status: 502 });
  return Response.json({ access_token: data.access_token });
}

export function GET(): Response {
  return Response.json({ ok: true, service: 'revu-exchange' });
}
