export interface ReleaseNotes {
  version: string;
  title: string;
  changes: string[];
}

declare const __BABYLONSLATE_VERSION__: string;
declare const __BABYLONSLATE_CHANGELOG__: ReleaseNotes[];

export function getApplicationVersion(): string {
  return typeof __BABYLONSLATE_VERSION__ === "undefined" ? "" : __BABYLONSLATE_VERSION__;
}

export function getChangelog(): ReleaseNotes[] {
  return typeof __BABYLONSLATE_CHANGELOG__ === "undefined" ? [] : __BABYLONSLATE_CHANGELOG__;
}
