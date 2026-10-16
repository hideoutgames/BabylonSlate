import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isProbablyBinary,
  scanCommitMessages,
  scanEventMetadata,
  scanPath,
  scanText,
  scanTrackedFiles,
  // @ts-expect-error -- plain .mjs tooling script, intentionally untyped.
} from "../../../scripts/check-public-hygiene.mjs";

const repoRoot = join(import.meta.dirname, "../../..");

// Markers are assembled at runtime so this file does not itself contain a
// scannable credential shape.
const fakeAwsKey = `AKIA${"Q".repeat(16)}`;
const fakeGithubToken = `ghp_${"a".repeat(36)}`;
const fakeSlackToken = `xoxb-${"1".repeat(12)}`;
const sessionLink = `https://app.${"devin"}.ai/sessions/0123456789abcdef`;
const claudeSessionLink = `https://${"claude"}.ai/code/session_01ABCdef0123456789`;

describe("public repository hygiene", () => {
  // Allow the full tracked-tree I/O scan to finish under coverage and concurrent builds.
  it("has no violations in tracked content", () => {
    const violations = scanTrackedFiles(repoRoot) as { path: string }[];
    expect(violations).toEqual([]);
  }, 20_000);

  it("flags agent session links and attribution footers", () => {
    expect(scanText("docs/x.md", sessionLink)).toMatchObject([
      { rule: "agent-session-link" },
    ]);
    expect(
      scanText("docs/x.md", "[Written by Devin](https://example.com)"),
    ).toMatchObject([{ rule: "agent-attribution" }]);
    expect(
      scanText("docs/x.md", "See the Devin docs at docs.devin.ai"),
    ).toEqual([]);
  });

  it("flags Claude Code session links, trailers and footers", () => {
    const flagged = [
      [claudeSessionLink, "agent-session-link"],
      [`${"Claude"}-Session: ${claudeSessionLink}`, "agent-session-link"],
      [`${"Co-Authored"}-By: Claude Opus <noreply@${"anthropic"}.com>`, "agent-request-attribution"],
      [`${"Co-authored"}-by: Someone <noreply@${"anthropic"}.com>`, "agent-request-attribution"],
      [`${"Claude"}-Session: pending`, "agent-request-attribution"],
      [`\u{1F916} ${"Generated"} with [Claude Code](https://example.com)`, "agent-attribution"],
      [`${"Generated"} by [Claude Code](https://example.com)`, "agent-attribution"],
    ];
    for (const [text, rule] of flagged) {
      expect(scanText("docs/x.md", text).map((violation: { rule: string }) => violation.rule)).toContain(rule);
    }
    expect(scanText("docs/x.md", "Claude Code reads AGENTS.md from the repository root.")).toEqual([]);
    expect(scanText("docs/x.md", "See https://claude.ai/code for the web app.")).toEqual([]);
  });

  it("scans pull request metadata without printing its contents", () => {
    expect(
      scanEventMetadata({
        pull_request: { title: sessionLink, body: "A change" },
      }),
    ).toMatchObject([
      { path: "pull-request:title", rule: "agent-session-link" },
    ]);
    expect(
      scanEventMetadata({
        issue: { pull_request: {} },
        comment: { body: "Requested by: @example" },
      }),
    ).toMatchObject([
      { path: "pull-request:comment", rule: "agent-request-attribution" },
    ]);
  });

  it("rejects session links and attribution in the pull request description", () => {
    expect(
      scanEventMetadata({
        pull_request: { title: "A change", body: `Summary\n\n${claudeSessionLink}` },
      }),
    ).toMatchObject([{ path: "pull-request:body", rule: "agent-session-link" }]);
    expect(
      scanEventMetadata({
        pull_request: {
          title: "A change",
          body: `${sessionLink}\n[Written by Devin](https://example.com)\n${fakeGithubToken}`,
        },
      }),
    ).toMatchObject([
      { path: "pull-request:body", rule: "agent-session-link" },
      { path: "pull-request:body", rule: "agent-attribution" },
      { path: "pull-request:body", rule: "github-token" },
    ]);
    expect(
      scanEventMetadata({
        issue: { pull_request: {} },
        comment: { body: sessionLink },
      }),
    ).toMatchObject([{ path: "pull-request:comment", rule: "agent-session-link" }]);
  });

  it("scans commit messages in only the requested range", () => {
    const directory = mkdtempSync(join(tmpdir(), "babylonslate-hygiene-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: directory,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
      writeFileSync(join(directory, "file.txt"), "one");
      execFileSync("git", ["add", "file.txt"], { cwd: directory });
      execFileSync("git", ["commit", "--quiet", "-m", "Clean change"], {
        cwd: directory,
      });
      writeFileSync(join(directory, "file.txt"), "two");
      execFileSync("git", ["add", "file.txt"], { cwd: directory });
      execFileSync(
        "git",
        ["commit", "--quiet", "-m", "Change", "-m", `${"Co-Authored"}-By: Claude <noreply@${"anthropic"}.com>`],
        { cwd: directory },
      );

      expect(scanCommitMessages("HEAD^..HEAD", directory)).toMatchObject([
        { rule: "agent-request-attribution" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats glTF JSON and lockfiles as scannable text", () => {
    expect(isProbablyBinary("model.gltf")).toBe(false);
    const config = readFileSync(join(repoRoot, ".gitleaks.toml"), "utf8");
    expect(config).not.toContain("pnpm-lock.yaml");
    expect(config).not.toContain("Podfile.lock");
    expect(config).not.toMatch(/glb\|gltf|gltf\|/);
  });

  it("flags credential markers", () => {
    const cases: [string, string][] = [
      [fakeAwsKey, "aws-access-key-id"],
      [fakeGithubToken, "github-token"],
      [fakeSlackToken, "slack-token"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----", "private-key-block"],
      [["-----BEGIN", " CERTIFICATE-----"].join(""), "certificate-block"],
      ['DEVELOPMENT_TEAM = "ABCDE12345";', "apple-signing-identity"],
    ];
    for (const [text, rule] of cases) {
      expect(scanText("apps/editor/x.txt", text), text).toMatchObject([
        { rule },
      ]);
    }
  });

  it("accepts the empty signing settings a clean Xcode project has", () => {
    expect(scanText("App.pbxproj", 'DEVELOPMENT_TEAM = "";')).toEqual([]);
    expect(
      scanText("App.pbxproj", "PROVISIONING_PROFILE_SPECIFIER = ;"),
    ).toEqual([]);
  });

  it("accepts Xcode variable references but rejects literal signing identifiers beside them", () => {
    for (const text of [
      'PROVISIONING_PROFILE_SPECIFIER = "$(BABYLONSLATE_PROVISIONING_PROFILE_SPECIFIER)";',
      'DEVELOPMENT_TEAM = "$(APPLE_TEAM_ID)";',
    ]) {
      expect(scanText("App.pbxproj", text)).toEqual([]);
    }

    for (const text of [
      'PROVISIONING_PROFILE_SPECIFIER = "12345678-1234-1234-1234-123456789abc";',
      'DEVELOPMENT_TEAM = "$(PREFIX)ABCDE12345";',
      'DEVELOPMENT_TEAM = "ABCDE12345$(SUFFIX)";',
      'DEVELOPMENT_TEAM = "$(APPLE_TEAM_ID)"; PROVISIONING_PROFILE = "12345678-1234-1234-1234-123456789abc";',
    ]) {
      expect(scanText("App.pbxproj", text)).toMatchObject([
        { rule: "apple-signing-identity" },
      ]);
    }
  });

  it("rejects sensitive paths regardless of contents", () => {
    expect(scanPath("certs/dist.p12")).toMatchObject([
      { rule: "signing-material" },
    ]);
    expect(scanPath("apps/editor/ios/App/Release.xcconfig")).toMatchObject([
      { rule: "xcode-export-config" },
    ]);
    expect(scanPath("apps/editor/.env.production")).toMatchObject([
      { rule: "environment-file" },
    ]);
    expect(scanPath(".env.example")).toEqual([]);
    expect(scanPath("packages/core/src/key.ts")).toEqual([]);
  });
});
