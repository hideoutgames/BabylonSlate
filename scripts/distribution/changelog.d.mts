export interface PatchNotes {
  version: string;
  title: string;
  changes: string[];
}
export function validatePatchNotes(notes: unknown, version: string): PatchNotes;
export function validateChangelog(value: unknown, version: string): PatchNotes[];
export function patchNotesMarkdown(notes: PatchNotes): string;
