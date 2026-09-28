// @ref LLP 0002#device-flow — the app owns the token: Keychain in, sidecar
// gets it per session, never written to disk by anyone.
import { Exact } from 'exact';

import { sidecar, type DeviceCodeStart } from './sidecar-client.ts';

const KEYCHAIN_KEY = 'github.access_token';

export interface AuthState {
  phase: 'unknown' | 'signed_out' | 'device_code' | 'authorizing' | 'signed_in' | 'error';
  login: string | null;
  userCode: string | null;
  verificationUri: string | null;
  error: string | null;
}

let state: AuthState = { phase: 'unknown', login: null, userCode: null, verificationUri: null, error: null };
const listeners = new Set<(state: AuthState) => void>();

export function getAuthState(): AuthState {
  return state;
}

export function onAuthChange(listener: (state: AuthState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: Partial<AuthState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
}

/** On launch: hand a stored token to the sidecar, or land on the sign-in screen. */
export async function restoreSession(): Promise<void> {
  try {
    const token = await Exact.secureStorage.get(KEYCHAIN_KEY);
    if (!token) {
      set({ phase: 'signed_out' });
      return;
    }
    const { login } = await sidecar.setToken(token);
    set({ phase: 'signed_in', login, error: null });
  } catch (error) {
    // A rejected token (revoked on GitHub) is a sign-out, not a crash.
    await Exact.secureStorage.delete(KEYCHAIN_KEY).catch(() => undefined);
    set({ phase: 'signed_out', login: null, error: error instanceof Error ? error.message : String(error) });
  }
}

let activeFlow: DeviceCodeStart | null = null;

export async function beginSignIn(): Promise<void> {
  try {
    activeFlow = await sidecar.startDeviceFlow();
    set({
      phase: 'device_code',
      userCode: activeFlow.user_code,
      verificationUri: activeFlow.verification_uri,
      error: null,
    });
    void Exact.shell.openExternal(activeFlow.verification_uri);
    void pollUntilGranted(activeFlow);
  } catch (error) {
    set({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

async function pollUntilGranted(flow: DeviceCodeStart): Promise<void> {
  let interval = Math.max(5, flow.interval);
  const deadline = Date.now() + flow.expires_in * 1000;
  while (Date.now() < deadline && activeFlow === flow) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    if (activeFlow !== flow) return;
    const result = await sidecar.pollDeviceFlow(flow.device_code).catch(() => ({ status: 'pending' as const }));
    switch (result.status) {
      case 'ok':
        await Exact.secureStorage.set(KEYCHAIN_KEY, result.access_token);
        activeFlow = null;
        set({ phase: 'signed_in', login: result.login, userCode: null, verificationUri: null, error: null });
        return;
      case 'slow_down':
        interval = result.interval;
        break;
      case 'expired':
      case 'denied':
        activeFlow = null;
        set({ phase: 'signed_out', userCode: null, verificationUri: null, error: `authorization ${result.status}` });
        return;
      default:
        set({ phase: 'authorizing' });
    }
  }
}

export async function signOut(): Promise<void> {
  activeFlow = null;
  await Exact.secureStorage.delete(KEYCHAIN_KEY).catch(() => undefined);
  await sidecar.clearToken().catch(() => undefined);
  set({ phase: 'signed_out', login: null, userCode: null, verificationUri: null, error: null });
}
