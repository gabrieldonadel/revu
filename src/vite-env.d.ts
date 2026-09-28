/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string;
}

// The source-linked @exact packages include Bun-executable scripts that read
// `import.meta.main`; this app's explicit `types` list excludes bun-types,
// so declare the property here for typechecking.
interface ImportMeta {
  readonly main?: boolean;
}
