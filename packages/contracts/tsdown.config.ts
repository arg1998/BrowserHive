import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config/index.ts',
    errors: 'src/errors/index.ts',
    harness: 'src/harness/index.ts',
    enums: 'src/enums/index.ts',
    ids: 'src/ids/index.ts',
    tools: 'src/tools/index.ts',
    http: 'src/http/index.ts',
    ws: 'src/ws/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  clean: true,
  outDir: 'dist',
});
