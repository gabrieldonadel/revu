/**
 * Native route selector (ENG-22509).
 *
 * The generated `src/__generated/routes/app/profiles.json` manifest names
 * this module as the `selectorModuleId` the native host loads to choose the
 * route registry chunk for the launch path. With the single core profile the
 * starter ships, every path resolves to the core chunk; add entries to
 * NATIVE_ROUTE_PROFILES in routes.profiles.ts (and a loader below) to split
 * routes onto their own native chunks.
 */
import {
  selectRouteProfileForPathname,
  type NativeRouteProfileName,
} from './routes.profiles.js';

export type NativeRouteProfile = NativeRouteProfileName;

type RuntimeRequire = (specifier: string) => unknown;

export function selectNativeRouteRegistrySpecifier(
  initialPath = readInitialPath(),
): string {
  return selectRouteProfileForPathname(readPathname(initialPath)).registryId;
}

export function selectNativeRouteProfile(
  initialPath = readInitialPath(),
): NativeRouteProfile {
  return selectRouteProfileForPathname(readPathname(initialPath)).profile;
}

export async function loadRuntimeRouteModules(): Promise<unknown> {
  const profile = selectNativeRouteProfile();
  (globalThis as { __exactNativeRouteProfile?: NativeRouteProfile }).__exactNativeRouteProfile =
    profile;
  const runtimeRequire = readRuntimeRequire();

  if (runtimeRequire) {
    return (
      runtimeRequire(selectNativeRouteRegistrySpecifier()) as {
        appRouteModules: unknown;
      }
    ).appRouteModules;
  }

  const module = await NATIVE_ROUTE_REGISTRY_LOADERS[profile]();
  return module.appRouteModules;
}

/**
 * Literal dynamic-import loaders, one per profile. Dynamic imports need
 * literal specifiers so the bundler can see (and ship) each chunk's module
 * graph; a profile missing here ships a bundle WITHOUT its chunk, which then
 * late-loads over the wire at boot and fails. The
 * `Record<NativeRouteProfileName, …>` type makes that drift a compile error —
 * add a loader whenever you add a profile.
 */
export const NATIVE_ROUTE_REGISTRY_LOADERS: Record<
  NativeRouteProfileName,
  () => Promise<{ appRouteModules: unknown }>
> = {
  app: () => import('./routes.runtime.native.core.js'),
};

function readInitialPath(): string {
  const initialPath = (globalThis as { __exactInitialPath?: string | undefined })
    .__exactInitialPath;
  return typeof initialPath === 'string' && initialPath ? initialPath : '/';
}

function readPathname(initialPath: string): string {
  try {
    return new URL(initialPath || '/', 'https://exact.local').pathname;
  } catch {
    return '/';
  }
}

function readRuntimeRequire(): RuntimeRequire | undefined {
  const runtimeRequire = (globalThis as { require?: RuntimeRequire | undefined })
    .require;
  return typeof runtimeRequire === 'function' ? runtimeRequire : undefined;
}
