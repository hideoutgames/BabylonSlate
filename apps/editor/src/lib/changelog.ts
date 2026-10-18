export interface ReleaseNotes {
  version: string;
  title: string;
  changes: string[];
}

declare const __BABYLONSLATE_VERSION__: string;

export function getApplicationVersion(): string {
  return typeof __BABYLONSLATE_VERSION__ === "undefined" ? "" : __BABYLONSLATE_VERSION__;
}

/** Published GitHub Releases, newest first; the app's only source of release notes. */
export const RELEASES_URL = "https://api.github.com/repos/hideoutgames/BabylonSlate/releases?per_page=100";

/** The fields of a GitHub Release that release notes are read from. */
export interface GitHubRelease {
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  published_at?: string | null;
}

/** The block `patchNotesMarkdown` in scripts/distribution/changelog.mjs writes into each release body. */
const NOTES_BLOCK = /<!--\s*haptic-release-notes\s+version="(\d+\.\d+\.\d+)"\s*-->([\s\S]*?)<!--\s*\/haptic-release-notes\s*-->/;

/** Release notes from a GitHub Release body, or null when it has no notes block. */
export function parseReleaseBody(body: string): ReleaseNotes | null {
  // Bodies edited on GitHub come back with CRLF line endings.
  const match = NOTES_BLOCK.exec(body.replace(/\r\n?/g, "\n"));
  if (!match) return null;
  const lines = match[2].split("\n").map(line => line.trim());
  const title = lines.find(line => line.startsWith("## "))?.slice(3).trim();
  const changes = lines
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim())
    .filter(Boolean);
  return title && changes.length ? { version: match[1], title, changes } : null;
}

function compareVersions(a: string, b: string): number {
  const right = b.split(".").map(Number);
  return a.split(".").map(Number).map((part, index) => part - right[index]).find(delta => delta !== 0) ?? 0;
}

/**
 * One entry per version up to the running one, newest first. Release builds
 * read only full releases; test and development builds also read test
 * prereleases, preferring a full release, then the newest prerelease.
 */
export function releaseNotesFromGitHub(
  releases: GitHubRelease[],
  { version, includePrereleases }: { version: string; includePrereleases: boolean },
): ReleaseNotes[] {
  const byVersion = new Map<string, { notes: ReleaseNotes; prerelease: boolean; published: number }>();
  for (const release of releases) {
    const prerelease = release.prerelease === true;
    if (release.draft || (prerelease && !includePrereleases)) continue;
    const notes = parseReleaseBody(release.body ?? "");
    if (!notes || (version && compareVersions(notes.version, version) > 0)) continue;
    const published = Date.parse(release.published_at ?? "") || 0;
    const existing = byVersion.get(notes.version);
    if (
      !existing ||
      (existing.prerelease && !prerelease) ||
      (existing.prerelease === prerelease && published > existing.published)
    ) {
      byVersion.set(notes.version, { notes, prerelease, published });
    }
  }
  return [...byVersion.values()]
    .map(entry => entry.notes)
    .sort((a, b) => compareVersions(b.version, a.version));
}
