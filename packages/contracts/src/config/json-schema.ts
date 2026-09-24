/** @module contracts/config/json-schema — JSON Schema (draft 2020-12) for `browserhive.config.json`, generated from the zod schema */
import { z } from 'zod';
import { GRAMMAR_META_KEY } from './grammar.ts';
import { isKeyMeta, parseKeyMeta } from './key.ts';
import { CONFIG_REF_PATTERN } from './refs.ts';
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

/** Name of the `$defs` entry a widened enum points at. */
export const CONFIG_REF_DEF = 'configRef';

/** `$defs.configRef`: a string holding at least one `{env:NAME}` reference (spec 08 §3.1). */
const CONFIG_REF_SCHEMA = {
  type: 'string',
  pattern: CONFIG_REF_PATTERN,
  description:
    'A reference such as {env:NAME} or {env:NAME:-default}, expanded from the environment when BrowserHive reads this file.',
} as const;

/** Keys of an enum node that describe the value itself and move into the enum branch of the `anyOf`. */
const ENUM_BRANCH_KEYS = new Set(['type', 'enum']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every enum node becomes `anyOf: [<the enum>, { $ref: configRef }]` with its annotations kept outside,
 * so an editor accepts `"stealth": "{env:STEALTH}"` and still rejects `"stealth": "banana"`. Every
 * other grammar already accepts a string (spec 08 §6).
 *
 * @returns A widened copy.
 */
function widenEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(widenEnums);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = widenEnums(value);
  if (!Array.isArray(out['enum'])) return out;
  const branch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out))
    if (ENUM_BRANCH_KEYS.has(key)) branch[key] = value;
  const anyOf = [branch, { $ref: `#/$defs/${CONFIG_REF_DEF}` }];
  // `anyOf` takes the place of `type`/`enum`, so annotations keep their order around it.
  const widened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (!ENUM_BRANCH_KEYS.has(key)) widened[key] = value;
    else if (!('anyOf' in widened)) widened['anyOf'] = anyOf;
  }
  return widened;
}

function keyOfSchema(schema: unknown): ConfigKey | undefined {
  return CONFIG_KEYS.find((key) => Object.is(CONFIG_SHAPE[key], schema));
}

/**
 * The JSON Schema for the config file: every key optional, `$schema` tolerated, unknown keys
 * rejected, CLI-only keys omitted. Each property carries `description`, `default`, `examples` and
 * the `x-browserhive-env` / `x-browserhive-cli` spellings; secrets carry `x-browserhive-secret`.
 * Enums also accept a string holding an `{env:NAME}` reference (`$defs.configRef`, spec 08 §3.1).
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
  const widened = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === 'properties' ? widenEnums(value) : value,
    ]),
  );
  return {
    ...widened,
    $defs: { [CONFIG_REF_DEF]: CONFIG_REF_SCHEMA },
    $id: CONFIG_FILE_SCHEMA_ID,
    title: 'BrowserHive configuration file',
    description:
      'browserhive.config.json. Precedence: defaults < environment < this file < CLI flags (rightmost wins).',
  };
}
