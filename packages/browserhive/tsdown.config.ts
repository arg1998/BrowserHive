import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  // Declarations only for the programmatic entry; workspace packages are inlined, so the
  // declaration build follows the project references (`tsc -b`).
  dts: { entry: ['**/src/index.ts'], build: true, compilerOptions: { declarationMap: false } },
  clean: true,
  outDir: 'dist',
  // `type: module` package: plain .js/.d.ts names match package.json `bin`/`exports`.
  fixedExtension: false,
  sourcemap: false,
  deps: {
    alwaysBundle: [/^@browserhive\//],
    neverBundle: ['bun:sqlite', 'bun'],
  },
  // `src/bin.ts` carries its own `#!/usr/bin/env bun`; rolldown preserves it.
});
