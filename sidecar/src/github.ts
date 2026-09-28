// @ref LLP 0002#device-flow — OAuth device flow; the sidecar never persists
// the token, the app keeps it in the Keychain and hands it over per session.
// @ref LLP 0001#polling — polling, not webhooks; honour X-Poll-Interval.

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'revu-sidecar/0.1 (+https://revu.donadel.dev)';

export interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'ok'; access_token: string; scope: string };

export async function startDeviceFlow(clientId: string, scopes: string[]): Promise<DeviceCodeStart> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, scope: scopes.join(' ') }),
  });
  if (!res.ok) throw new Error(`device/code failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as DeviceCodeStart;
}

export async function pollDeviceFlow(clientId: string, deviceCode: string): Promise<DevicePollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const body = (await res.json()) as {
    error?: string;
    interval?: number;
    access_token?: string;
    scope?: string;
  };
  if (body.access_token) return { status: 'ok', access_token: body.access_token, scope: body.scope ?? '' };
  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down', interval: body.interval ?? 10 };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      throw new Error(`device flow error: ${body.error ?? 'unknown'}`);
  }
}

export interface GitHubUser {
  login: string;
}

export interface ReviewRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  requested_at: string;
  state: string;
  updated_at: string;
}

export interface PollOutcome {
  requests: ReviewRequest[];
  /** Server-requested minimum seconds between polls (X-Poll-Interval). */
  pollInterval: number | null;
  notModified: boolean;
  lastModified: string | null;
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  async me(): Promise<GitHubUser> {
    const res = await fetch(`${GITHUB_API}/user`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GET /user failed: ${res.status}`);
    return (await res.json()) as GitHubUser;
  }

  /**
   * The authoritative list of open PRs where the user is a requested reviewer.
   * Search does not support conditional requests, so it is the slow full
   * refresh; `/notifications` below is the cheap incremental signal.
   */
  async openReviewRequests(): Promise<ReviewRequest[]> {
    const q = encodeURIComponent('is:open is:pr review-requested:@me archived:false');
    const res = await fetch(`${GITHUB_API}/search/issues?q=${q}&per_page=100&sort=updated`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      items: Array<{
        number: number;
        title: string;
        html_url: string;
        state: string;
        updated_at: string;
        created_at: string;
        user: { login: string };
        repository_url: string;
      }>;
    };
    return body.items.map((item) => {
      const repo = item.repository_url.replace(`${GITHUB_API}/repos/`, '');
      return {
        id: `${repo}#${item.number}`,
        repo,
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user.login,
        // Search does not expose when the review was requested; updated_at is
        // the closest honest proxy until the notification carries the real time.
        requested_at: item.updated_at,
        state: item.state,
        updated_at: item.updated_at,
      };
    });
  }

  /**
   * Incremental signal: notifications with reason=review_requested. Uses
   * If-Modified-Since so an unchanged inbox costs no rate limit (304).
   */
  async reviewRequestNotifications(lastModified: string | null): Promise<PollOutcome> {
    const res = await fetch(`${GITHUB_API}/notifications?participating=true&per_page=50`, {
      headers: this.headers(lastModified ? { 'If-Modified-Since': lastModified } : {}),
    });
    const pollInterval = Number(res.headers.get('x-poll-interval')) || null;
    if (res.status === 304) {
      return { requests: [], pollInterval, notModified: true, lastModified };
    }
    if (!res.ok) throw new Error(`notifications failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Array<{
      reason: string;
      updated_at: string;
      repository: { full_name: string };
      subject: { type: string; title: string; url: string | null };
    }>;
    const requests: ReviewRequest[] = [];
    for (const n of body) {
      if (n.reason !== 'review_requested' || n.subject.type !== 'PullRequest' || !n.subject.url) continue;
      const pr = await this.pullRequest(n.subject.url);
      if (!pr) continue;
      requests.push({ ...pr, requested_at: n.updated_at });
    }
    return {
      requests,
      pollInterval,
      notModified: false,
      lastModified: res.headers.get('last-modified') ?? lastModified,
    };
  }

  private async pullRequest(apiUrl: string): Promise<Omit<ReviewRequest, 'requested_at'> | null> {
    const res = await fetch(apiUrl, { headers: this.headers() });
    if (!res.ok) return null;
    const pr = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      merged: boolean;
      updated_at: string;
      user: { login: string };
      base: { repo: { full_name: string } };
    };
    const repo = pr.base.repo.full_name;
    return {
      id: `${repo}#${pr.number}`,
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      state: pr.merged ? 'merged' : pr.state,
      updated_at: pr.updated_at,
    };
  }
}
