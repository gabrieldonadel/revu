// GENERATED FILE — do not edit by hand.
// Emitted by packages/exact-devtools/src/scripts/generate-route-registries.ts
// from src/app/routes/** and src/app/routes.profiles.ts (LLP 0154 P3).
// Regenerate with `bun run generate:routes` at the project root.
import type { RouteManifestOwnerIndexRowV1 } from '@exact/router/route-manifest';

// @system @ref LLP 0444 D0/D2 / RFC 0494 §4.1 — lazy ownership
// projection. Native delivery loads this module off the boot graph.
export const appRouteOwnerIndex =
[
  {
    "pattern": "/about",
    "routeId": "app/about.contract",
    "owner": {
      "kind": "core"
    }
  },
  {
    "pattern": "/",
    "routeId": "app/index.contract",
    "owner": {
      "kind": "core"
    }
  }
] as const satisfies readonly RouteManifestOwnerIndexRowV1[];

export const routeRegistryGenerationStamp = "sha256:899ea30701e462689d118012f1d47e19c25b6be528823df3e13644b02ce18e43";
