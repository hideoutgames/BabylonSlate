import { describe, expect, it } from "vitest";
import { patchNotesMarkdown } from "../../../../scripts/distribution/changelog.mjs";
import { parseReleaseBody, releaseNotesFromGitHub, type GitHubRelease } from "./changelog";

const notes = (version: string, title = `Haptic ${version}`) => ({
  version,
  title,
  changes: [`Changes in ${version}.`, "Projects reopen faster."],
});

/** A GitHub Release body as the release workflow writes it: notes, then build details. */
const body = (version: string, title?: string) =>
  `${patchNotesMarkdown(notes(version, title))}\n\nHaptic ${version}\nChannel: Release\n\nWindows: Unsigned x64 NSIS installer.`;

const release = (version: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  body: body(version),
  published_at: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("parseReleaseBody", () => {
  it("reads the notes the release workflow writes and ignores the build details", () => {
    expect(parseReleaseBody(body("0.0.1", "Updates And Release News"))).toEqual(
      notes("0.0.1", "Updates And Release News"),
    );
  });

  it("reads bodies edited on GitHub, which come back with CRLF line endings", () => {
    expect(parseReleaseBody(body("0.0.1").replace(/\n/g, "\r\n"))).toEqual(notes("0.0.1"));
  });

  it("returns null for releases without a notes block or without changes", () => {
    expect(parseReleaseBody("Haptic 0.0.1\nChannel: Release")).toBeNull();
    expect(
      parseReleaseBody('<!-- haptic-release-notes version="0.0.1" -->\n## Title\n<!-- /haptic-release-notes -->'),
    ).toBeNull();
  });
});

describe("releaseNotesFromGitHub", () => {
  it("lists one entry per version up to the running one, newest first", () => {
    const result = releaseNotesFromGitHub(
      [
        release("0.1.0"),
        release("0.3.0"),
        release("0.10.0"),
        release("0.2.0", { draft: true }),
        { body: "No notes here." },
      ],
      { version: "0.3.0", includePrereleases: false },
    );
    expect(result.map(entry => entry.version)).toEqual(["0.3.0", "0.1.0"]);
  });

  it("shows test prereleases only to test and development builds, preferring a full release", () => {
    const releases = [
      release("0.2.0", { prerelease: true, body: body("0.2.0", "Older Test"), published_at: "2026-01-01T00:00:00Z" }),
      release("0.2.0", { prerelease: true, body: body("0.2.0", "Newer Test"), published_at: "2026-02-01T00:00:00Z" }),
      release("0.1.0", { prerelease: true, body: body("0.1.0", "Test"), published_at: "2026-03-01T00:00:00Z" }),
      release("0.1.0", { body: body("0.1.0", "Release"), published_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(
      releaseNotesFromGitHub(releases, { version: "0.2.0", includePrereleases: false }).map(entry => entry.title),
    ).toEqual(["Release"]);
    expect(
      releaseNotesFromGitHub(releases, { version: "0.2.0", includePrereleases: true }).map(entry => entry.title),
    ).toEqual(["Newer Test", "Release"]);
  });
});
