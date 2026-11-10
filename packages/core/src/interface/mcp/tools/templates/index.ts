/** @module interface/mcp/tools/templates — list_templates (spec 13 §5.1). */

import { defineTool, json, type ToolPack } from '../../definition.ts';

/**
 * `list_templates`: the templates the caller may launch. The pack is disabled under
 * `templates=false` (`TOOL_NOT_AVAILABLE`); the access rule is applied per template, so a template
 * the caller may not use is simply absent (D-52).
 */
export const listTemplates = defineTool('list_templates', {
  policies: [],
  async handler(ctx) {
    const templates = await ctx.services.templates.listForAgent({
      principal: ctx.principal,
      client: ctx.client,
    });
    return json({ templates: [...templates] });
  },
});

/** The templates pack. */
export const templatesPack: ToolPack = {
  id: 'templates',
  tools: [listTemplates],
};
