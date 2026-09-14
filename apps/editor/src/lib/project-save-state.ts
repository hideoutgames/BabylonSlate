import type { ProjectDocument } from "@babylonslate/core";

type ProjectSaveToken = { owner: number; document: ProjectDocument };

/** Settings/version are authored project state; registry path refreshes are derived. */
export class ProjectSaveState {
  private owner = 0;
  private saved: ProjectDocument | null = null;

  reset(document: ProjectDocument | null): void {
    this.owner++;
    this.saved = document;
  }

  capture(document: ProjectDocument): ProjectSaveToken {
    return { owner: this.owner, document };
  }

  complete(token: ProjectSaveToken): void {
    // A late write from a closed/reloaded project cannot acknowledge its successor.
    if (token.owner === this.owner) this.saved = token.document;
  }

  isDirty(document: ProjectDocument | null): boolean {
    return document !== null && (
      this.saved === null ||
      document.settings !== this.saved.settings ||
      document.metadata.version !== this.saved.metadata.version
    );
  }
}
