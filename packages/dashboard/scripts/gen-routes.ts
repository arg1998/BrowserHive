/** @module dashboard/scripts/gen-routes — regenerate `src/routeTree.gen.ts` outside Vite (typecheck, CI) */
import { Generator, getConfig } from '@tanstack/router-generator';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const config = getConfig(
  {
    target: 'react',
    autoCodeSplitting: true,
    routesDirectory: `${root}/src/routes`,
    generatedRouteTree: `${root}/src/routeTree.gen.ts`,
    quoteStyle: 'single',
    semicolons: true,
    disableLogging: true,
  },
  root,
);
await new Generator({ config, root }).run();
