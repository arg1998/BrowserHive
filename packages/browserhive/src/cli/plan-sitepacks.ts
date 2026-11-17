/** @module cli/plan-sitepacks — the `sitepacks` subcommands' flags → their invocations (spec 13 §11.5). `verify` is offline: it resolves nothing but its path. */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { CliPlan } from './invocation.ts';
import { type PlanInput, run, usage } from './plan-resolve.ts';

/**
 * Plans one `sitepacks` subcommand.
 *
 * @returns The plan.
 */
export function planSitepacks(name: string, input: PlanInput): CliPlan {
  const { reader, color, args } = input;
  switch (name) {
    case 'sitepacks verify': {
      const json = reader.bool('json');
      if (reader.problems.length > 0) return usage(reader.problems);
      const raw = args[0] ?? '';
      const path = isAbsolute(raw) ? raw : resolvePath(input.context.cwd, raw);
      return run({ command: 'sitepacks-verify', path, json }, color);
    }
    default:
      return usage([`unsupported invocation '${name}'.`]);
  }
}
