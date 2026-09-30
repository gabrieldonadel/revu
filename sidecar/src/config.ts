// @ref LLP 0001#configuration — one config file, no secrets in it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RevuConfig {
  github: { oauthClientId: string; scopes: string[]; pollIntervalSeconds?: number };
  sidecar: { host?: string; port?: number };
}

/** Where a packaged sidecar (bun build --compile, inside revu.app/Contents/Resources) keeps its files. */
export const bundleDir = dirname(process.execPath);

/** The repo's config, or the one beside a packaged binary, or the built-in default. */
export function loadConfig(root = resolve(import.meta.dir, '../..')): RevuConfig {
  for (const candidate of [resolve(root, 'revu.config.json'), resolve(bundleDir, 'revu.config.json')]) {
    if (!existsSync(candidate)) continue;
    const raw = JSON.parse(readFileSync(candidate, 'utf8')) as RevuConfig;
    if (!raw.github?.oauthClientId) throw new Error(`${candidate}: github.oauthClientId is required`);
    return raw;
  }
  return { github: { oauthClientId: 'Ov23li3weoDK9jZ4ycnp', scopes: ['notifications', 'repo', 'read:user'], pollIntervalSeconds: 60 }, sidecar: { host: '127.0.0.1', port: 47831 } };
}

export const paths = {
  appSupport: `${process.env.HOME}/Library/Application Support/revu`,
  db: `${process.env.HOME}/Library/Application Support/revu/state.db`,
};
