import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scanAddedLines,
  scanPath,
  scanText,
  scanTrackedFiles,
  selfReferentialPaths,
  // @ts-expect-error -- plain .mjs tooling script, intentionally untyped.
} from "../../../scripts/check-public-hygiene.mjs";

const repoRoot = join(import.meta.dirname, "../../..");

// Markers are assembled at runtime so this file does not itself contain a
// scannable credential shape.
const fakeAwsKey = `AKIA${"Q".repeat(16)}`;
const fakeGithubToken = `ghp_${"a".repeat(36)}`;
const fakeSlackToken = `xoxb-${"1".repeat(12)}`;
const sessionLink = `https://app.${"devin"}.ai/sessions/0123456789abcdef`;

describe("public repository hygiene", () => {
  it("has no violations in tracked content", () => {
    const violations = scanTrackedFiles(repoRoot) as { path: string }[];
    expect(violations).toEqual([]);
  });

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

  it("scans a git range without violations on recent history", () => {
    const hasParent = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (Number(hasParent) < 2) {
      return;
    }
    expect(scanAddedLines("HEAD~1..HEAD", repoRoot)).toEqual([]);
  });

  it("keeps the self-referential allowlist small enough to audit", () => {
    expect([...selfReferentialPaths]).toEqual([
      "scripts/check-public-hygiene.mjs",
      "packages/test-kit/src/public-hygiene.test.ts",
    ]);
  });
});
