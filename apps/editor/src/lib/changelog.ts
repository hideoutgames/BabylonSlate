export interface ReleaseNotes {
  version: string;
  title: string;
  changes: string[];
}

declare const __HAPTIC_VERSION__: string;
declare const __HAPTIC_RELEASE_NOTES__: ReleaseNotes | null;

export function getApplicationVersion(): string {
  return typeof __HAPTIC_VERSION__ === "undefined" ? "" : __HAPTIC_VERSION__;
}

/** The running version's notes, embedded at build time from release/changelog.json. */
export function getReleaseNotes(): ReleaseNotes | null {
  return typeof __HAPTIC_RELEASE_NOTES__ === "undefined" ? null : __HAPTIC_RELEASE_NOTES__;
}
