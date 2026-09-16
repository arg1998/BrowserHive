/** @module contracts/config/json-schema — JSON Schema (draft 2020-12) for `browserhive.config.json`, generated from the zod schema */
import { z } from 'zod';
import { GRAMMAR_META_KEY } from './grammar.ts';
import { isKeyMeta, parseKeyMeta } from './key.ts';
import { CONFIG_KEYS, keyMeta, namesFor } from './registry.ts';
import { CONFIG_SHAPE, type ConfigKey } from './shape.ts';

/** `$id` of the generated schema; the docs site hosts a versioned copy. */
export const CONFIG_FILE_SCHEMA_ID = 'https://browserhive.ai/schemas/browserhive.config.json';

const INTERNAL_META_KEYS = [
  'describe',
  'group',
  'secret',
  'restartRequired',
  'cliOnly',
  'derivedFrom',
  'defaultText',
  GRAMMAR_META_KEY,
] as const;

function keyOfSchema(schema: unknown): ConfigKey | undefined {
  return CONFIG_KEYS.find((key) => Object.is(CONFIG_SHAPE[key], schema));
}

/**
 * The JSON Schema for the config file: every key optional, `$schema` tolerated, unknown keys
 * rejected, CLI-only keys omitted. Each property carries `description`, `default`, `examples` and
 * the `x-browserhive-env` / `x-browserhive-cli` spellings; secrets carry `x-browserhive-secret`.
 *
 * @returns A JSON-serializable schema object.
 */
export function configFileJsonSchema(): Record<string, unknown> {
  const properties: Record<string, z.ZodType> = {
    $schema: z
      .string()
      .optional()
      .meta({ description: 'JSON Schema reference for editor support.' }),
  };
  for (const key of CONFIG_KEYS) {
    if (keyMeta(key).cliOnly) continue;
    properties[key] = CONFIG_SHAPE[key].optional();
  }
  const fileObject = z.object(properties).strict();
  const schema = z.toJSONSchema(fileObject, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: (ctx) => {
      const rawMeta = z.globalRegistry.get(ctx.zodSchema);
      if (!isKeyMeta(rawMeta)) return;
      const key = keyOfSchema(ctx.zodSchema);
      const meta = parseKeyMeta(rawMeta);
      const json: Record<string, unknown> = ctx.jsonSchema;
      for (const internal of INTERNAL_META_KEYS) delete json[internal];
      json['description'] =
        meta.derivedFrom !== undefined && !/derived/i.test(meta.describe)
          ? `${meta.describe} Derived from ${meta.derivedFrom} when unset.`
          : meta.describe;
      if (meta.defaultText !== undefined) json['default'] = meta.defaultText;
      if (key !== undefined) {
        const names = namesFor(key);
        json['x-browserhive-env'] = names.env;
        json['x-browserhive-cli'] = names.cli;
        if (meta.secret) json['x-browserhive-secret'] = true;
        if (!meta.restartRequired) json['x-browserhive-runtime'] = true;
      }
    },
  });
  return {
    ...schema,
    $id: CONFIG_FILE_SCHEMA_ID,
    title: 'BrowserHive configuration file',
    description:
      'browserhive.config.json. Precedence: defaults < environment < this file < CLI flags (rightmost wins).',
  };
}
