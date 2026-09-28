// GENERATED FILE — do not edit by hand.
// Emitted by packages/exact-devtools/src/scripts/generate-route-registries.ts
// from src/app/routes/** and src/app/routes.profiles.ts (LLP 0154 P3).
// Regenerate with `bun run generate:routes` at the project root.
import { defineRouteModules } from '@exact/router/types';
import type { RouteManifestRuntimeRowV1 } from '@exact/router/route-manifest';
import { defineContractRouteModule } from './contract-route-module.js';


const aboutRoute = defineContractRouteModule(() => import('./routes/about.contract'), { screen: { title: "About" } as const, head: { title: "About" } });
const indexRoute = defineContractRouteModule(() => import('./routes/index.contract'), { screen: { title: "Index" } as const, head: { title: "Index" } });

// Mixed registry for server-side tooling and route introspection. The
// live runtime loads the generated platform registries instead so startup
// never evaluates the wrong platform's route modules.
export const appRouteModules = defineRouteModules({
  'app/about.contract': aboutRoute,
  'app/index.contract': indexRoute,
});

// Runtime projection of __generated/routes/app/route-manifest.generated.json (RFC 0494 R-A).
export const appRouteManifest =
[] as const satisfies readonly RouteManifestRuntimeRowV1[];
