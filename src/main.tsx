/**
 * Routed Contract entrypoint (LLP 0160, LLP 0154).
 *
 * The app is the route files under src/app/routes/; this file is the thin
 * boot shim: it builds the file router over the GENERATED registry
 * (src/app/routes.runtime.web.ts, emitted by `bun run generate:routes`),
 * attaches browser history, and mounts the Contract router adapter into the
 * page. On a plain browser tab the Contract web host renders into real DOM;
 * inside a platform host the host keeps ownership of pixels.
 */

import { reset } from '@exact/contract/runtime';
import {
  installContractWebHost,
  type ContractWebHostHandle,
} from '@exact/renderer/web-host';
import { attachBrowserHistory } from '@exact/router/browser';
import {
  createContractRouterAdapter,
  mountContractRouterAdapter,
} from '@exact/router/contract';
import { createFileRouter } from '@exact/router/core';

import { appRouteModules } from './app/routes.runtime.web.js';
import { appEnvironment } from './app-environment.js';

let disposeApp: (() => void) | null = null;

console.info(`[ExactStarter] build environment: ${appEnvironment.name}`);

function initialPath(): string {
  // Base-path deployments: the served document's inline bootstrap publishes
  // the base-stripped boot path as `__exactInitialPath` (and the prefix as
  // `__exactAppBasePath`). Prefer the bootstrap value; otherwise strip the
  // prefix from the live URL so deep links under a base path still match
  // app routes.
  const bootGlobals = globalThis as {
    __exactInitialPath?: string;
    __exactAppBasePath?: string;
  };
  if (typeof bootGlobals.__exactInitialPath === 'string' && bootGlobals.__exactInitialPath) {
    return bootGlobals.__exactInitialPath;
  }
  const { pathname, search, hash } = window.location;
  const basePath = bootGlobals.__exactAppBasePath ?? '/';
  const routePath = basePath === '/'
    ? pathname
    : pathname === basePath
      ? '/'
      : pathname.startsWith(`${basePath}/`)
        ? pathname.slice(basePath.length)
        : pathname;
  return `${routePath}${search}${hash}`;
}

async function mountApp(): Promise<void> {
  const router = createFileRouter({
    modules: appRouteModules,
    appDir: 'app',
    platform: 'web',
    initialPath: initialPath(),
  });

  const rootElement = document.getElementById('exact-root') ?? document.body;
  rootElement.replaceChildren();

  const detachHistory = attachBrowserHistory(router);
  const webHost: ContractWebHostHandle | null = installContractWebHost({
    container: rootElement,
  });

  await router.initialize();
  const adapter = createContractRouterAdapter(router);
  const handle = await mountContractRouterAdapter(adapter);

  disposeApp = () => {
    detachHistory();
    handle.dispose();
    webHost?.dispose();
    reset();
    disposeApp = null;
  };
}

void mountApp().catch((error: unknown) => {
  console.error('[ExactStarter] router mount failed', error);
});

// HMR (ENG-24639): edits to a `.contract` route are handled at that module's
// own hot boundary — the Contract runtime applies a slot patch or
// state-preserving refresh in place (structural changes remount that surface,
// keeping the last-good UI on errors), so named component state and the
// current route survive compatible edits without this file re-running.
// Updates that do land here (this entry, the generated route registry)
// self-accept and remount in place — the reset fallback — instead of forcing
// a full page reload; the URL carries the current route across that remount.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    disposeApp?.();
  });
}
