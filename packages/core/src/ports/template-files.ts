/** @module ports/template-files — a template's directory on disk (`<data-dir>/templates/<template_id>/`, spec 13 §2.4). Templates T1b adds the encrypted checkpoint and version files behind `TemplateStateStore`. */

/** The template directories. */
export interface TemplateFiles {
  /** `<data-dir>/templates/<template_id>`. */
  dirOf(templateId: string): string;
  /**
   * Deletes the template's directory and returns the bytes its regular files held (symbolic links
   * are removed, never followed). A missing directory is `0`.
   */
  removeTemplateDir(templateId: string): Promise<number>;
}
