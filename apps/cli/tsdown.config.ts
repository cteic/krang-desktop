import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/placeholder.ts'],
  format: 'esm',
  platform: 'node',
});
