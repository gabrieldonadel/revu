/**
 * Native route-profile configuration consumed by `bun run generate:routes`
 * and the native route selector `src/app/route-modules.native.ts` (see the
 * main Exact repo's docs/adding-a-route.md for the full shape).
 *
 * This starter keeps ONE core profile that carries every route, so all
 * routes are reachable on every platform. When you add a route file under
 * src/app/routes/, add its logical path (no extension) to `routes` below —
 * a route missing from every profile still works on web but silently
 * renders not-found on native (the generator WARNS about it — see
 * REQUIRE_NATIVE_ROUTE_COVERAGE).
 */

/**
 * The native route profiles this app splits its route registry across. With
 * the single core profile the starter ships, this is just `'app'`; add a
 * string here (and a matching entry in NATIVE_ROUTE_PROFILES plus a loader in
 * route-modules.native.ts) to carve routes onto their own native chunk.
 */
export type NativeRouteProfileName = 'app';

export interface NativeRouteProfile {
  profile: NativeRouteProfileName;
  registryId: string;
  match: {
    exact?: readonly string[];
    prefixes?: readonly string[];
    excludeExact?: readonly string[];
  };
  routes: readonly string[];
}

export const NON_ROUTE_MODULES: readonly string[] = [];

export const CORE_PROFILE: NativeRouteProfile = {
  profile: 'app',
  registryId: '/src/app/routes.runtime.native.core.ts',
  match: {},
  routes: ['index', 'about'],
};

export const NATIVE_ROUTE_PROFILES: readonly NativeRouteProfile[] = [];

/**
 * Routes intentionally absent from every native registry (web-only screens).
 * Listing one here suppresses the unprofiled-route coverage warning below.
 */
export const WEB_ONLY_ROUTES: readonly string[] = [];

/**
 * Scaffolded apps WARN — they do not fail generation — when a route is claimed
 * by no profile, so growing past the single core profile stays safe
 * (LLP 0279 W2). Add the route's logical path to CORE_PROFILE.routes to
 * silence the warning; flip this to `true` once the app is native-shipping to
 * turn an unprofiled route into a hard error.
 */
export const REQUIRE_NATIVE_ROUTE_COVERAGE = false;

export const CONTRACT_ROUTE_SCREEN: Readonly<Record<string, never>> = {};

/**
 * Pick the native registry chunk for a pathname. With the single core profile
 * every path resolves to CORE_PROFILE; each entry added to
 * NATIVE_ROUTE_PROFILES can claim routes by exact path or prefix. Kept
 * import-free (pure data plus this matcher) so `generate:routes` can load it.
 */
export function selectRouteProfileForPathname(
  pathname: string,
): NativeRouteProfile {
  for (const profile of NATIVE_ROUTE_PROFILES) {
    if (profile.match.excludeExact?.includes(pathname)) {
      continue;
    }
    if (profile.match.exact?.includes(pathname)) {
      return profile;
    }
    if (profile.match.prefixes?.some((prefix) => pathname.startsWith(prefix))) {
      return profile;
    }
  }
  return CORE_PROFILE;
}
