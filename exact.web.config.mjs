import { defineExactWebConfig } from '@exact/server/config';

export default defineExactWebConfig({
  build: {
    command: ['bun', 'run', 'build'],
  },
  artifactDir: 'dist/exact-web',
  // Required when `exact start --host` binds outside loopback.
  // publicOrigin: 'https://app.example.com',
});
