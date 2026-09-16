import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  outDir: 'dist',
  external: [/^@browserhive\//, 'bun:sqlite', 'bun'],
});
