// Plain-object view model for the Contract routes. Contract re-derives when
// the `tick` argument changes, so routes pass their clock state through.
import { beginSignIn, getAuthState, signOut } from './auth.ts';
import { getSnapshot, sidecar } from './sidecar-client.ts';

export interface PrView {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  unread: boolean;
  age: string;
}

export interface RevuView {
  connected: boolean;
  phase: string;
  login: string;
  userCode: string;
  verificationUri: string;
  error: string;
  lastPoll: string;
  unread: number;
  total: number;
  prs: PrView[];
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function getView(_tick: number): RevuView {
  const auth = getAuthState();
  const snap = getSnapshot();
  const prs = snap.prs.map((pr) => ({
    id: pr.id,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    unread: pr.seen === 0,
    age: age(pr.requested_at),
  }));
  return {
    connected: snap.connected,
    phase: auth.phase,
    login: auth.login ?? '',
    userCode: auth.userCode ?? '',
    verificationUri: auth.verificationUri ?? '',
    error: auth.error ?? snap.lastPollError ?? '',
    lastPoll: snap.lastPollAt ? age(snap.lastPollAt) : 'never',
    unread: prs.filter((pr) => pr.unread).length,
    total: prs.length,
    prs,
  };
}

export function signIn(): void {
  void beginSignIn();
}

export function signOutNow(): void {
  void signOut();
}

export function refreshNow(): void {
  void sidecar.pollNow().catch(() => undefined);
}

export function markRead(id: string): void {
  void sidecar.markSeen(id, true);
}

