import { defineConfig } from 'vite';
import { exactContractWeb } from '@exact/devtools/contract-web';

export default defineConfig({
  // Public build-time values with this prefix are available through
  // import.meta.env in both web and native bundles.
  envPrefix: ['VITE_'],
  plugins: [
    // The paved-road preset deliberately uses browser/module/import/default
    // package conditions (not `development`), dependency optimization, plugin
    // order, and opt-in agent-readiness in development and production.
    // Development keeps the full compatibility host; production selects the
    // direct real-DOM Contract host.
    // EXACT_AGENT_READINESS_VITE remains an explicit opt-in in either mode.
    exactContractWeb({
      app: {
        entry: '/src/main.tsx',
        // This scaffold is cross-platform even when created with --target
        // web, so retain the Exact app plugin's native/desktop build outputs.
        platformOutputs: 'exact-app',
      },
    }),
  ],
  resolve: {
    // React is a real dependency of this app (the renderer uses it at
    // runtime, and the native dep optimizer must be able to resolve it from
    // this root — ENG-22663/ENG-23265); dedupe so the source-linked @exact
    // packages resolve this app's copy (two React instances break hooks).
    dedupe: ['react', 'react-dom'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // Raw development loader data is intentionally loopback-only by default.
    // Change this explicitly when testing on a trusted LAN device.
    host: '127.0.0.1',
    port: 8083,
  },
});
