/** Layer rules for the BrowserHive monorepo (specs/01-overall-architecture.md §4, specs/05 §4.1). */
module.exports = {
  forbidden: [
    {
      name: 'kernel-is-leaf',
      severity: 'error',
      from: { path: '^packages/core/src/kernel' },
      to: { path: '^packages/core/src/(domain|ports|infra|app|interface)' },
    },
    {
      name: 'domain-no-infra',
      severity: 'error',
      from: { path: '^packages/core/src/(domain|ports)' },
      to: { path: '^packages/core/src/(infra|app|interface)' },
    },
    {
      name: 'infra-no-app',
      severity: 'error',
      from: { path: '^packages/core/src/infra' },
      to: { path: '^packages/core/src/(app|interface)' },
    },
    {
      name: 'app-no-infra',
      severity: 'error',
      from: { path: '^packages/core/src/app' },
      to: { path: '^packages/core/src/(infra|interface)' },
    },
    {
      name: 'interface-no-infra',
      severity: 'error',
      from: { path: '^packages/core/src/interface' },
      to: { path: '^packages/core/src/infra' },
    },
    {
      name: 'playwright-only-in-browsers',
      severity: 'error',
      from: {
        path: '^packages/',
        pathNot: ['^packages/core/src/infra/browsers', '^packages/[^/]+/test', '\\.test\\.tsx?$'],
      },
      to: { path: '^(playwright|patchright|playwright-core)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'sqlite-only-in-persistence',
      severity: 'error',
      from: {
        path: '^packages/',
        pathNot: [
          '^packages/core/src/infra/persistence',
          '^packages/[^/]+/test',
          '\\.test\\.tsx?$',
        ],
      },
      to: { path: '^(kysely|bun:sqlite)' },
    },
    {
      name: 'contracts-platform-neutral',
      severity: 'error',
      from: { path: '^packages/contracts/src', pathNot: '\\.test\\.tsx?$' },
      to: { path: '^(node:|bun:|bun-types|bun$)' },
    },
    {
      name: 'dashboard-only-contracts',
      severity: 'error',
      from: { path: '^packages/dashboard' },
      to: { path: '^packages/(core|browserhive)' },
    },
    {
      name: 'no-deep-cross-package-imports-contracts',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/(?!contracts/)[^/]+/', dependencyTypes: ['local'] },
    },
    {
      name: 'no-deep-cross-package-imports-core',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(?!core/)[^/]+/', dependencyTypes: ['local'] },
    },
    {
      name: 'no-deep-cross-package-imports-dashboard',
      severity: 'error',
      from: { path: '^packages/dashboard/' },
      to: { path: '^packages/(?!dashboard/)[^/]+/', dependencyTypes: ['local'] },
    },
    {
      name: 'no-deep-cross-package-imports-browserhive',
      severity: 'error',
      from: { path: '^packages/browserhive/' },
      to: { path: '^packages/(?!browserhive/)[^/]+/', dependencyTypes: ['local'] },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['node_modules', 'dist', '\\.gen\\.ts$', 'generated/'] },
    tsPreCompilationDeps: 'specify',
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'bun', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
