/** @module test/helpers/fake-host-ops — a scriptable `TemplateHostOps` for the recording service and route suites: a jar the test edits, a recording session that is open or not, and the calls made. */

import type { Session } from '../../src/domain/session/session.ts';
import type { Cookie } from '../../src/ports/browser-driver.ts';
import type { TemplateRecord } from '../../src/ports/persistence/index.ts';
import type { SignInRemoval, TemplateHost } from '../../src/ports/template-host.ts';
import type {
  RecordingRequest,
  SharedWindowView,
  TemplateHostOps,
  TemplateOperationHold,
} from '../../src/ports/template-runtime.ts';

/** Fake host operations; `jarCookies === null` = the browser is stopped. */
export class FakeTemplateHostOps implements TemplateHostOps {
  jarCookies: Cookie[] | null = null;
  shared: SharedWindowView[] = [];
  readonly opened: RecordingRequest[] = [];
  readonly removed: string[] = [];
  readonly clearedSecrets: string[] = [];
  closed = 0;
  /** The open recording session (a stand-in with an id). */
  recording: Session | null = null;

  async jar(): Promise<readonly Cookie[] | null> {
    return this.jarCookies === null ? null : [...this.jarCookies];
  }

  async sharedWindows(): Promise<readonly SharedWindowView[]> {
    return this.shared;
  }

  /** Origins the next removals report as not cleared. */
  uncleared: string[] = [];

  async removeSignIn(_template: TemplateRecord, domain: string): Promise<SignInRemoval> {
    this.removed.push(domain);
    const before = this.jarCookies?.length ?? 0;
    this.jarCookies =
      this.jarCookies?.filter((c) => !`.${c.domain.replace(/^\./, '')}`.endsWith(`.${domain}`)) ??
      null;
    return {
      cookiesRemoved: before - (this.jarCookies?.length ?? 0),
      origins: [`https://${domain}`],
      unclearedOrigins: [...this.uncleared],
    };
  }

  async clearProfileSecrets(template: TemplateRecord): Promise<void> {
    this.clearedSecrets.push(template.templateId);
  }

  async openRecording(request: RecordingRequest): Promise<Session> {
    this.opened.push(request);
    this.jarCookies ??= [];
    this.recording ??= { id: 'recording-0000aaaa' } as Session;
    return this.recording;
  }

  recordingOf(): Session | null {
    return this.recording;
  }

  async closeRecording(): Promise<void> {
    this.closed += 1;
    this.recording = null;
  }

  /** The browser `withHost` hands out (`null`: it cannot start). */
  host: TemplateHost | null = null;
  /** Templates held by an operation. */
  readonly holds = new Set<string>();
  /** Host operations, in order (`start:<id>`, `stop:<id>`, `restart:<id>`, `drain:<id>:<force>`). */
  readonly calls: string[] = [];
  /** Sessions `drainForOperation` and `stopHost` report closed. */
  liveSessions: string[] = [];
  parkedTargets: string[] = [];

  hold(templateId: string): TemplateOperationHold | null {
    if (this.holds.has(templateId)) return null;
    this.holds.add(templateId);
    return { token: Symbol(templateId), release: () => void this.holds.delete(templateId) };
  }

  held(templateId: string): boolean {
    return this.holds.has(templateId);
  }

  async withHost<T>(_template: TemplateRecord, fn: (host: TemplateHost) => Promise<T>): Promise<T> {
    if (this.host === null) throw new Error('no browser');
    return await fn(this.host);
  }

  async startHost(template: TemplateRecord): Promise<void> {
    this.calls.push(`start:${template.templateId}`);
  }

  async stopHost(template: TemplateRecord): Promise<readonly string[]> {
    this.calls.push(`stop:${template.templateId}`);
    return this.liveSessions.splice(0);
  }

  async restartHost(template: TemplateRecord): Promise<void> {
    this.calls.push(`restart:${template.templateId}`);
  }

  async closeParkedPage(_templateId: string, targetId: string): Promise<boolean> {
    const before = this.parkedTargets.length;
    this.parkedTargets = this.parkedTargets.filter((t) => t !== targetId);
    return this.parkedTargets.length < before;
  }

  async drainForOperation(
    template: TemplateRecord,
    forceClose: boolean,
  ): Promise<readonly string[]> {
    this.calls.push(`drain:${template.templateId}:${forceClose}`);
    return this.liveSessions.splice(0);
  }
}
