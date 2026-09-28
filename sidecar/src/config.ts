// @ref LLP 0001#configuration — one config file, no secrets in it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RevuConfig {
  github: { oauthClientId: string; scopes: string[]; pollIntervalSeconds?: number };
  sidecar: { host?: string; port?: number };
}

export function loadConfig(root = resolve(import.meta.dir, '../..')): RevuConfig {
  const raw = JSON.parse(readFileSync(resolve(root, 'revu.config.json'), 'utf8')) as RevuConfig;
  if (!raw.github?.oauthClientId) throw new Error('revu.config.json: github.oauthClientId is required');
  return raw;
}

export const paths = {
  appSupport: `${process.env.HOME}/Library/Application Support/revu`,
  db: `${process.env.HOME}/Library/Application Support/revu/state.db`,
};
