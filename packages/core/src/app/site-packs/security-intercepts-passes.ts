/** @module app/site-packs/security-intercepts-passes — the one-time passes an approval grants (spec 13 §9.3): the tool path's pass for the same guard, URL, tool and target for 10 minutes, and, once that is used, one network pass for the request guard behind it on the same site for 60 seconds (review PR #83 L6 narrowed both). */

/** An approval on the tool path grants a one-time pass for the same guard and URL this long. */
export const WRITE_PASS_MS = 10 * 60_000;
/**
 * A tool-path pass that was used grants the network guard one pass for the request guard behind it
 * this long (the click that the approval covered sends its write within it).
 */
export const NETWORK_PASS_MS = 60_000;

/** Who approved the write a pass stands for. */
export interface PassGrant {
  readonly requestId: string;
  readonly decidedBy: string | null;
}

interface Pass extends PassGrant {
  readonly expiresAt: number;
  /** Network passes: the registrable domain the write must go to. */
  readonly site?: string;
}

/** What a tool-path pass is for: one action on one control. */
export interface ToolPassKey {
  readonly sessionId: string;
  /** `<pack id>#<guard id>`. */
  readonly guard: string;
  readonly url: string;
  readonly tool: string;
  /** The control the agent named (selector or role and name), when the tool layer passes it. */
  readonly target: string | null;
}

/** The passes of every session. */
export class PassBook {
  readonly #tool = new Map<string, Pass>();
  readonly #network = new Map<string, Pass>();

  grantTool(key: ToolPassKey, grant: PassGrant, now: number): void {
    this.#prune(now);
    this.#tool.set(toolKey(key), { ...grant, expiresAt: now + WRITE_PASS_MS });
  }

  takeTool(key: ToolPassKey, now: number): PassGrant | null {
    return take(this.#tool, toolKey(key), now);
  }

  /** One pass for a request-guard rule of the session, for writes to `site` only. */
  grantNetwork(
    sessionId: string,
    ruleId: string,
    site: string,
    grant: PassGrant,
    now: number,
  ): void {
    this.#prune(now);
    this.#network.set(join(sessionId, ruleId), {
      ...grant,
      site,
      expiresAt: now + NETWORK_PASS_MS,
    });
  }

  /** Uses the network pass of a rule when the write goes to the site it was granted for. */
  takeNetwork(sessionId: string, ruleId: string, site: string, now: number): PassGrant | null {
    const key = join(sessionId, ruleId);
    const pass = this.#network.get(key);
    if (pass === undefined || pass.site !== site) return null;
    return take(this.#network, key, now);
  }

  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const map of [this.#tool, this.#network]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
  }

  #prune(now: number): void {
    for (const map of [this.#tool, this.#network]) {
      for (const [key, pass] of map) if (pass.expiresAt <= now) map.delete(key);
    }
  }
}

function join(...parts: readonly string[]): string {
  return parts.join('\u0000');
}

function toolKey(key: ToolPassKey): string {
  return join(key.sessionId, key.guard, key.url, key.tool, key.target ?? '');
}

function take(map: Map<string, Pass>, key: string, now: number): PassGrant | null {
  const pass = map.get(key);
  if (pass === undefined) return null;
  map.delete(key);
  if (pass.expiresAt <= now) return null;
  return { requestId: pass.requestId, decidedBy: pass.decidedBy };
}
