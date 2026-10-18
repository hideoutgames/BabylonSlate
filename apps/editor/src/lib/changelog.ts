export interface ReleaseNotes {
  version: string;
  title: string;
  changes: string[];
}

declare const __BABYLONSLATE_VERSION__: string;
declare const __BABYLONSLATE_RELEASE_NOTES__: ReleaseNotes | null;

export function getApplicationVersion(): string {
  return typeof __BABYLONSLATE_VERSION__ === "undefined" ? "" : __BABYLONSLATE_VERSION__;
}

/** The running version's notes, embedded at build time from release/changelog.json. */
export function getReleaseNotes(): ReleaseNotes | null {
  return typeof __BABYLONSLATE_RELEASE_NOTES__ === "undefined" ? null : __BABYLONSLATE_RELEASE_NOTES__;
}
