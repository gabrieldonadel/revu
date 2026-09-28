// @ref LLP 0001#transport — HTTP for requests, one WebSocket for pushes;
// `snapshot` is truth, `review_requested` is only the notification trigger.

export interface PullRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  requested_at: string;
  first_seen_at: string;
  seen: number;
  state: string;
  updated_at: string;
}

export interface Snapshot {
  login: string | null;
  prs: PullRequest[];
  lastPollAt: string | null;
  lastPollError: string | null;
}

export type SidecarEvent =
  | ({ type: 'snapshot' } & Snapshot)
  | { type: 'review_requested'; pr: PullRequest }
  | { type: 'auth'; login: string | null };

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
  | { status: 'ok'; login: string; access_token: string; scope: string };

const BASE = 'http://127.0.0.1:47831';

type Listener = (event: SidecarEvent) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

let current: Snapshot & { connected: boolean } = {
  login: null,
  prs: [],
  lastPollAt: null,
  lastPollError: null,
  connected: false,
};

export function getSnapshot(): Snapshot & { connected: boolean } {
  return current;
}

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: SidecarEvent): void {
  if (event.type === 'snapshot') {
    current = { ...current, login: event.login, prs: event.prs, lastPollAt: event.lastPollAt, lastPollError: event.lastPollError };
  } else if (event.type === 'auth') {
    current = { ...current, login: event.login };
  }
  for (const listener of listeners) listener(event);
}

export function connect(): void {
  if (socket) return;
  try {
    socket = new WebSocket(`${BASE.replace('http', 'ws')}/events`);
  } catch (error) {
    console.warn('[revu] sidecar socket failed to construct', error);
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    current = { ...current, connected: true };
    emit({ type: 'snapshot', ...current });
  };
  socket.onmessage = (message) => {
    try {
      emit(JSON.parse(String(message.data)) as SidecarEvent);
    } catch (error) {
      console.warn('[revu] bad sidecar event', error);
    }
  };
  socket.onclose = () => {
    socket = null;
    current = { ...current, connected: false };
    emit({ type: 'snapshot', ...current });
    scheduleReconnect();
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const sidecar = {
  health: async () => (await fetch(`${BASE}/health`)).json() as Promise<{ ok: boolean; login: string | null; authenticated: boolean }>,
  startDeviceFlow: () => post<DeviceCodeStart>('/auth/device/start'),
  pollDeviceFlow: (device_code: string) => post<DevicePollResult>('/auth/device/poll', { device_code }),
  setToken: (access_token: string) => post<{ login: string }>('/auth/token', { access_token }),
  clearToken: async () => {
    await fetch(`${BASE}/auth/token`, { method: 'DELETE' });
  },
  pollNow: () => post<Snapshot>('/poll'),
  markSeen: (id: string, seen = true) => post<{ ok: boolean }>(`/prs/${encodeURIComponent(id)}/seen`, { seen }),
};
