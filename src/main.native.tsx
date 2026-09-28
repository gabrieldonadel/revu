// @platform-split: native runtime entry avoids browser DOM APIs (LLP 0154, LLP 0243)
/**
 * Native entrypoint: mounts the same generated route registry the web entry
 * uses, over the Contract router adapter, without touching the DOM. The
 * native host resolves /src/main.tsx to this file (mac -> native ->
 * unsuffixed).
 */

import { reset } from '@exact/contract/runtime';
import { hostCallAsync } from '@exact/core/host-call-bridge';
import 'exact/dom-viewport';
import {
  createContractRouterAdapter,
  mountContractRouterAdapter,
} from '@exact/router/contract';
// '@exact/router/router' types against the neutral surface; at serve time
// the native module pipeline resolves the package source through the shared
// platform order and picks router.native.ts.
import { createFileRouter } from '@exact/router/router';

import { appRouteModules } from './app/routes.runtime.native.core.js';
import { appEnvironment } from './app-environment.js';

type StarterNativeGlobal = typeof globalThis & {
  __exactHandleLinkHref?: (href: string) => void | Promise<void>;
  __exactDisposeApp?: () => void;
  __exactInitialPath?: string;
  __exactPlatform?: unknown;
  HermesInternal?: unknown;
  process?: { platform?: unknown };
  open?: (url: string, target?: string) => unknown;
};

const starterGlobal = globalThis as StarterNativeGlobal;

console.info(`[ExactStarter] build environment: ${appEnvironment.name}`);

function getPlatform(): string {
  if (
    typeof starterGlobal.__exactPlatform === 'string' &&
    starterGlobal.__exactPlatform.length > 0
  ) {
    return normalizePlatform(starterGlobal.__exactPlatform);
  }
  if (typeof starterGlobal.process?.platform === 'string') {
    return normalizePlatform(starterGlobal.process.platform);
  }
  return typeof starterGlobal.HermesInternal !== 'undefined' ? 'ios' : 'unknown';
}

function normalizePlatform(name: string): string {
  return name === 'darwin' || name === 'macos' ? 'mac' : name;
}

const router = createFileRouter({
  modules: appRouteModules,
  appDir: 'app',
  platform: getPlatform(),
  initialPath: starterGlobal.__exactInitialPath ?? '/',
});

// Native link taps arrive through this host sink (there is no DOM anchor to
// follow). Internal paths drive the router; anything else opens externally.
starterGlobal.__exactHandleLinkHref = async (href: string): Promise<void> => {
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('?')) {
    await router.push(trimmed);
    return;
  }
  const pending = hostCallAsync(
    'desktop.shell.openExternal',
    JSON.stringify({ url: trimmed }),
  );
  if (pending) {
    await pending;
  } else if (typeof starterGlobal.open === 'function') {
    starterGlobal.open(trimmed, '_blank');
  }
};

async function mountApp(): Promise<void> {
  // Initialize before mounting: the Contract adapter has no fallback shell
  // to render while the match list is empty.
  await router.initialize();
  const adapter = createContractRouterAdapter(router);
  const handle = await mountContractRouterAdapter(adapter);

  starterGlobal.__exactDisposeApp = () => {
    handle.dispose();
    reset();
    starterGlobal.__exactDisposeApp = undefined;
  };
}

void mountApp().catch((error: unknown) => {
  console.error('[ExactStarter] native mount failed', error);
});

// HMR (ENG-24639): the native module pipeline strips `import.meta.hot`, so
// this block is inert on device — native reloads ride the host pipeline, and
// `.contract` edits are patched in place at each compiled module's own
// boundary by the Contract runtime's state-preserving hot-update decision.
// Under a hot-capable host that does evaluate this entry, self-accept and
// remount in place — the reset fallback — instead of forcing a full reload.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    starterGlobal.__exactDisposeApp?.();
  });
}
