// @ts-check
import { readFileSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

/** Written by scripts/sync-docs.ts before dev and build. */
const manifest = JSON.parse(
  readFileSync(new URL('./src/generated/docs.json', import.meta.url), 'utf8'),
);

/** Every version's sidebar; route middleware keeps only the current page's version. */
const sidebar = manifest.versions.flatMap((/** @type {{label: string, base: string}} */ v) => [
  { label: 'Overview', link: v.base },
  ...manifest.sidebars[v.label],
]);

export default defineConfig({
  site: 'https://browserhive.ai',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'BrowserHive',
      description:
        'Local-first MCP server that gives AI agents isolated, stealthy browser sessions with safe password logins, human takeover and a full audit trail.',
      logo: { src: './src/assets/logo.svg', alt: 'BrowserHive' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/arg1998/BrowserHive' }],
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/theme.css',
        './src/styles/docs.css',
      ],
      sidebar,
      routeMiddleware: './src/route-middleware.ts',
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      lastUpdated: true,
      pagination: true,
      credits: false,
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '0.75rem',
          borderColor: 'var(--hive-line)',
          codeFontFamily: 'var(--sl-font-mono)',
          uiFontFamily: 'var(--sl-font)',
          frames: {
            shadowColor: 'transparent',
            editorActiveTabIndicatorTopColor: 'var(--hive-honey)',
            terminalTitlebarDotsOpacity: '0.35',
          },
        },
      },
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#07090d' } },
        {
          tag: 'link',
          attrs: { rel: 'alternate', type: 'text/plain', href: '/llms.txt', title: 'llms.txt' },
        },
      ],
      components: {
        Header: './src/components/DocsHeader.astro',
        PageSidebar: './src/components/PageSidebar.astro',
        PageTitle: './src/components/PageTitle.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
    }),
  ],
});
