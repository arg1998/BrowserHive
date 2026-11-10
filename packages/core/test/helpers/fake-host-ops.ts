/** @module test/helpers/fake-host-ops — a scriptable `TemplateHostOps` for the recording service and route suites: a jar the test edits, a recording session that is open or not, and the calls made. */

import type { Session } from '../../src/domain/session/session.ts';
import type { Cookie } from '../../src/ports/browser-driver.ts';
import type { TemplateRecord } from '../../src/ports/persistence/index.ts';
import type {
  RecordingRequest,
  SharedWindowView,
  TemplateHostOps,
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

  async removeSignIn(_template: TemplateRecord, domain: string): Promise<number> {
    this.removed.push(domain);
    const before = this.jarCookies?.length ?? 0;
    this.jarCookies =
      this.jarCookies?.filter((c) => !`.${c.domain.replace(/^\./, '')}`.endsWith(`.${domain}`)) ??
      null;
    return before - (this.jarCookies?.length ?? 0);
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
}
