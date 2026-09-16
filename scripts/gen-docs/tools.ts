/** @module scripts/gen-docs/tools — renders docs/reference/tools.md from the frozen tool contracts */
import {
  ALL_TOOL_NAMES,
  TOOL_CONTRACTS,
  TOOL_PACKS,
  type ToolContract,
  type ToolName,
  ToolPackId,
  toolInputJsonSchema,
  toolOutputJsonSchema,
} from '@browserhive/contracts/tools';
import {
  anchor,
  describeConstraints,
  describeType,
  document,
  type FieldRow,
  GENERATED_HEADER,
  inlineCode,
  isRecord,
  jsonValue,
  objectFields,
  table,
} from './markdown.ts';

/** The contract fields the docs need (a structural subset, so no generic widening of `input`). */
type ContractFacts = Pick<
  ToolContract,
  'title' | 'description' | 'annotations' | 'pack' | 'capability' | 'errors' | 'since'
>;

const PACK_TITLES: Readonly<Record<ToolPackId, string>> = {
  lifecycle: 'Lifecycle',
  introspection: 'Introspection',
  navigation: 'Navigation',
  tabs: 'Tabs',
  interaction: 'Interaction',
  inspection: 'Inspection',
  waits: 'Waits',
  dialogs: 'Dialogs',
  state: 'Cookies and state',
  files: 'Files',
  authStates: 'Auth states',
  attention: 'Attention (HTTP transport only)',
  vault: 'Vault',
};

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function parameterRows(fields: readonly FieldRow[]): string[][] {
  return fields.map((f) => {
    const node = isRecord(f.schema) ? f.schema : {};
    const described = typeof node['description'] === 'string' ? [node['description']] : [];
    const notes = [...described, ...describeConstraints(f.schema)];
    return [
      inlineCode(f.name),
      describeType(f.schema),
      yesNo(f.required),
      'default' in node ? jsonValue(node['default']) : '—',
      notes.join('; ') || '—',
    ];
  });
}

function parametersBlock(name: ToolName): string {
  const fields = objectFields(toolInputJsonSchema(name));
  if (fields.length === 0) return 'Parameters: none.';
  return [
    'Parameters:',
    '',
    table(['Name', 'Type', 'Required', 'Default', 'Notes'], parameterRows(fields)),
  ].join('\n');
}

function fieldTable(fields: readonly FieldRow[]): string {
  return table(
    ['Field', 'Type', 'Always present'],
    fields.map((f) => [inlineCode(f.name), describeType(f.schema), yesNo(f.required)]),
  );
}

function resultBlock(name: ToolName): string {
  const schema = toolOutputJsonSchema(name);
  if (isRecord(schema) && schema['type'] === 'array') {
    const itemFields = objectFields(schema['items']);
    if (itemFields.length === 0) return `Result: array of ${describeType(schema['items'])}.`;
    return ['Result: a JSON array; each item has:', '', fieldTable(itemFields)].join('\n');
  }
  const fields = objectFields(schema);
  if (fields.length === 0) return `Result: ${describeType(schema)}.`;
  return [
    'Result (JSON text block, mirrored in `structuredContent`):',
    '',
    fieldTable(fields),
  ].join('\n');
}

function toolSection(name: ToolName): string {
  const contract: ContractFacts = TOOL_CONTRACTS[name];
  const a = contract.annotations;
  const errors =
    contract.errors.length === 0
      ? 'none documented'
      : contract.errors.map((code) => `[${inlineCode(code)}](errors.md#${code})`).join(', ');
  return [
    anchor(name),
    `### ${inlineCode(name)}`,
    '',
    `**${contract.title}** · capability ${inlineCode(contract.capability)} · since ${contract.since}`,
    '',
    contract.description
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    '',
    `Annotations: readOnly ${yesNo(a.readOnlyHint)} · destructive ${yesNo(a.destructiveHint)} · idempotent ${yesNo(a.idempotentHint)} · openWorld ${yesNo(a.openWorldHint)}`,
    '',
    parametersBlock(name),
    '',
    resultBlock(name),
    '',
    `Errors: ${errors}. Any tool may also return [${inlineCode('INVALID_ARGUMENTS')}](errors.md#INVALID_ARGUMENTS) and [${inlineCode('INTERNAL_ERROR')}](errors.md#INTERNAL_ERROR).`,
  ].join('\n');
}

function packSection(pack: ToolPackId): string {
  const names = TOOL_PACKS[pack];
  if (names.length === 0) return '';
  return [`## ${PACK_TITLES[pack]}`, '', names.map(toolSection).join('\n\n')].join('\n');
}

/**
 * Render `docs/reference/tools.md`.
 *
 * @returns The Markdown document.
 */
export function renderTools(): string {
  const catalog = table(
    ['#', 'Tool', 'Pack', 'Title', 'RO', 'Destructive', 'Idempotent', 'Open world'],
    ALL_TOOL_NAMES.map((name, i) => {
      const contract: ContractFacts = TOOL_CONTRACTS[name];
      const a = contract.annotations;
      return [
        String(i + 1),
        `[${inlineCode(name)}](#${name})`,
        PACK_TITLES[contract.pack],
        contract.title,
        yesNo(a.readOnlyHint),
        yesNo(a.destructiveHint),
        yesNo(a.idempotentHint),
        yesNo(a.openWorldHint),
      ];
    }),
  );
  return document([
    GENERATED_HEADER,
    '# MCP tool reference',
    `The ${ALL_TOOL_NAMES.length} tools BrowserHive registers, in registration order, generated from \`TOOL_CONTRACTS\` in \`@browserhive/contracts/tools\`. Names, parameters, defaults and result shapes are a frozen contract. Every page-targeting tool accepts an optional \`tab_id\` (defaults to the active tab). Errors are returned as \`[CODE] message\` text; see the [error reference](errors.md).`,
    'Defaults shown for `launch_session` `channel` and `headless` are the contract defaults; a server started with `--defaultChannel` / `--defaultHeadless` advertises its configured values in `tools/list`.',
    '## Catalog',
    catalog,
    ...ToolPackId.options.map(packSection),
  ]);
}
