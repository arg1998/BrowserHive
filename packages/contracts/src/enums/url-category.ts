/** @module contracts/enums/url-category — UrlCategory enum: Bucket a navigated URL falls into; stored on `pages.category`. */

import { z } from 'zod';

/**
 * Bucket a navigated URL falls into; stored on `pages.category`.
 */
export const UrlCategory = z.enum(['public', 'ip', 'local', 'ftp', 'other']);
/** Union of {@link UrlCategory} members. */
export type UrlCategory = z.infer<typeof UrlCategory>;
