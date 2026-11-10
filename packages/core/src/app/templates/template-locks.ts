/** @module app/templates/template-locks — the per-template exclusion between deleting a template and launching from it: a launch never starts on a template being deleted, and a delete either refuses in-flight launches (`TEMPLATE_IN_USE`) or, with `force`, waits for them to settle before it closes their sessions. */

/** In-flight launches and running deletes, per template id. */
export class TemplateLocks {
  readonly #launching = new Map<string, number>();
  readonly #deleting = new Set<string>();
  readonly #idle = new Map<string, (() => void)[]>();

  /** Whether a delete of `templateId` is running. */
  isDeleting(templateId: string): boolean {
    return this.#deleting.has(templateId);
  }

  /** Launches of `templateId` that have not settled. */
  inFlight(templateId: string): number {
    return this.#launching.get(templateId) ?? 0;
  }

  /**
   * Registers a launch; call it synchronously after checking {@link isDeleting}.
   *
   * @returns The release to call once the launch settled, whatever its outcome.
   */
  beginLaunch(templateId: string): () => void {
    this.#launching.set(templateId, this.inFlight(templateId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.inFlight(templateId) - 1;
      if (left > 0) {
        this.#launching.set(templateId, left);
        return;
      }
      this.#launching.delete(templateId);
      for (const wake of this.#idle.get(templateId) ?? []) wake();
      this.#idle.delete(templateId);
    };
  }

  /**
   * Marks a delete as running.
   *
   * @returns `null` when another delete of `templateId` already runs, else the release.
   */
  beginDelete(templateId: string): (() => void) | null {
    if (this.#deleting.has(templateId)) return null;
    this.#deleting.add(templateId);
    return () => {
      this.#deleting.delete(templateId);
    };
  }

  /** Resolves once no launch of `templateId` is in flight. */
  settled(templateId: string): Promise<void> {
    if (this.inFlight(templateId) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.#idle.get(templateId) ?? [];
      waiting.push(resolve);
      this.#idle.set(templateId, waiting);
    });
  }
}
