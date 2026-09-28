// GENERATED FILE — do not edit by hand.
// Emitted by packages/exact-devtools/src/scripts/generate-route-registries.ts
// from src/app/routes/** and src/app/routes.profiles.ts (LLP 0154 P3).
// Regenerate with `bun run generate:routes` at the project root.
import type { RouteModuleMap } from '@exact/router/types';
import type { RouteManifestRuntimeRowV1 } from '@exact/router/route-manifest';

import { defineContractRouteModule } from './contract-route-module.js';

const aboutRoute = defineContractRouteModule(() => import('./routes/about.contract'), { screen: { title: "About" } as const, head: { title: "About" } });
const indexRoute = defineContractRouteModule(() => import('./routes/index.contract'), { screen: { title: "Index" } as const, head: { title: "Index" } });

export const appRouteModules = {
  'app/about.contract': aboutRoute,
  'app/index.contract': indexRoute,
} satisfies RouteModuleMap;

// Runtime projection of __generated/routes/app/route-manifest.generated.json (RFC 0494 R-A).
export const appRouteManifest =
[] as const satisfies readonly RouteManifestRuntimeRowV1[];

export const routeRegistryGenerationStamp = "sha256:73c7176bb168ab3227bb00c1168114fd853ed1575561df40b32f9d20e99061e9";
