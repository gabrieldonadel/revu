/**
 * Public app configuration shared by web and native entries. Vite resolves
 * matching .env files and process variables when the bundle is built; Exact
 * bakes the resulting values into native modules, so no device runtime
 * environment is implied.
 */
export interface AppEnvironment {
  readonly name: string;
}

export const appEnvironment: AppEnvironment = {
  name: import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE,
};
