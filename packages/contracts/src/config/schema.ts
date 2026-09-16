/** @module contracts/config/schema — `serverConfigSchema`: the one zod object every config source, help text and doc is generated from (D-06) */
import { crossFieldIssues, type ExplicitKeys, NO_EXPLICIT_KEYS } from './rules.ts';
import { serverConfigObject } from './shape.ts';

export {
  CONFIG_SHAPE,
  type ConfigKey,
  type ServerConfig,
  type ServerConfigInput,
  serverConfigObject,
} from './shape.ts';

/**
 * Build the full schema for a given set of explicitly supplied keys. Rules 3, 4 and 7 of spec 08
 * §4.1 only fire for explicit values, which the resolver knows and the schema alone does not.
 *
 * @returns A schema equal to `serverConfigObject` plus the cross-field `superRefine`.
 */
export function serverConfigSchemaFor(explicit: ExplicitKeys) {
  return serverConfigObject.superRefine((config, ctx) => {
    for (const issue of crossFieldIssues(config, explicit)) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: [issue.path],
        ...(issue.code !== undefined && { params: { code: issue.code } }),
      });
    }
  });
}

/** The schema with every provenance-independent cross-field rule applied. */
export const serverConfigSchema = serverConfigSchemaFor(NO_EXPLICIT_KEYS);
