import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /** Path of the source file in the repository, e.g. `docs/guide/cli.md`. */
        sourcePath: z.string().optional(),
        /** Docs major this page belongs to, e.g. `v0`. */
        docsVersion: z.string().optional(),
      }),
    }),
  }),
};
