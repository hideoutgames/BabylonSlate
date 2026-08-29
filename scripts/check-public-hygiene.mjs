#!/usr/bin/env node
// Rejects things that must never appear in a public repository: links to agent
// sessions, credential markers, and developer-specific Apple signing identifiers.
//
// gitleaks (.gitleaks.toml) covers generic high-entropy credentials. This check
// covers the repository's own policy, which gitleaks has no notion of, and runs
// anywhere Node runs — no macOS, no Xcode, no network.
//
// Usage:
//   node scripts/check-public-hygiene.mjs                 # tracked files at HEAD
//   node scripts/check-public-hygiene.mjs --range A...B    # + lines added in a range

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * Files that legitimately contain the patterns below, because they define or
 * exercise them. Kept to the checker and its test on purpose: every entry here
 * is a hole in the check, so the list must stay short enough to audit by eye.
 */
export const selfReferentialPaths = new Set([
  "scripts/check-public-hygiene.mjs",
  "packages/test-kit/src/public-hygiene.test.ts",
]);

const binaryExtensions = new Set([
  ".basis",
  ".bin",
  ".dds",
  ".glb",
  ".gltf",
  ".hdr",
  ".ico",
  ".jpeg",
  ".jpg",
  ".ktx2",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".wasm",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/**
 * Each entry is a single-line regex applied to file contents and to added diff
 * lines. `hint` is printed on a match and should say what to do, not restate the
 * pattern.
 */
export const contentRules = [
  {
    id: "agent-session-link",
    // Session and attachment URLs of agent tools. These are private, expire, and
    // leak internal workflow into a public repo.
    regex:
      /https?:\/\/[^\s"'`<>)\]]*(?:devin\.ai|cursor\.(?:com|sh))\/(?:sessions?|attachments?|agents?)\//i,
    hint: "Remove the agent session/attachment link; describe the change instead.",
  },
  {
    id: "agent-attribution",
    regex:
      /\[(?:written|generated|created) by (?:devin|cursor|copilot)[^\]]*\]|🤖\s*generated with/i,
    hint: "Remove the agent attribution footer.",
  },
  {
    id: "private-key-block",
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    hint: "Never commit private keys. Rotate this key — assume it is disclosed.",
  },
  {
    id: "certificate-block",
    regex: /-----BEGIN (?:CERTIFICATE|PKCS7)-----/,
    hint: "Signing certificates belong in a local keychain or CI secret, not git.",
  },
  {
    id: "aws-access-key-id",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    hint: "Rotate this AWS key immediately, then remove it.",
  },
  {
    id: "github-token",
    regex:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/,
    hint: "Rotate this GitHub token immediately, then remove it.",
  },
  {
    id: "slack-token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{12,}\b/,
    hint: "Rotate this Slack token immediately, then remove it.",
  },
  {
    id: "apple-signing-identity",
    // A team ID or profile UUID identifies the developer account and is never
    // needed for a simulator build; see SECURITY.md.
    regex:
      /\b(?:DEVELOPMENT_TEAM|PROVISIONING_PROFILE|PROVISIONING_PROFILE_SPECIFIER)\b\s*=\s*(?!""|"";|;)\S/,
    hint: "Keep signing identifiers in a local, gitignored .xcconfig.",
  },
];

/**
 * Tracked paths that are sensitive by name, whatever their contents. `.gitignore`
 * should stop these first; this catches a `git add -f` past it.
 */
export const forbiddenPathRules = [
  {
    id: "signing-material",
    regex:
      /(?:^|\/)(?!.*\.example$).*\.(?:p12|pfx|cer|certSigningRequest|mobileprovision|provisionprofile|keystore|jks|pem|key)$/i,
    hint: "Signing material and private keys must not be tracked.",
  },
  {
    id: "environment-file",
    regex: /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/,
    hint: "Only .env.example may be tracked, and only with placeholder values.",
  },
  {
    id: "ssh-key",
    regex: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
    hint: "SSH keys must not be tracked.",
  },
  {
    id: "xcode-export-config",
    regex: /(?:^|\/)(?:ExportOptions\.plist|.*\.xcconfig)$/,
    hint: "Export/signing configuration stays local and gitignored.",
  },
];

/** @returns {{path: string, line: number, rule: string, hint: string}[]} */
export function scanText(path, text) {
  if (selfReferentialPaths.has(path)) {
    return [];
  }
  const violations = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of contentRules) {
      if (rule.regex.test(line)) {
        violations.push({
          path,
          line: index + 1,
          rule: rule.id,
          hint: rule.hint,
        });
      }
    }
  }
  return violations;
}

/** @returns {{path: string, line: number, rule: string, hint: string}[]} */
export function scanPath(path) {
  if (selfReferentialPaths.has(path)) {
    return [];
  }
  return forbiddenPathRules
    .filter((rule) => rule.regex.test(path))
    .map((rule) => ({ path, line: 0, rule: rule.id, hint: rule.hint }));
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function trackedFiles(cwd) {
  return git(["ls-files", "-z"], cwd).split("\0").filter(Boolean);
}

function isProbablyBinary(path, text) {
  return (
    binaryExtensions.has(extname(path).toLowerCase()) || text.includes("\0")
  );
}

export function scanTrackedFiles(cwd) {
  const violations = [];
  for (const path of trackedFiles(cwd)) {
    violations.push(...scanPath(path));
    let text;
    try {
      text = readFileSync(`${cwd}/${path}`, "utf8");
    } catch {
      // Submodules and files removed from the working tree have nothing to scan.
      continue;
    }
    if (isProbablyBinary(path, text)) {
      continue;
    }
    violations.push(...scanText(path, text));
  }
  return violations;
}

/** Scans only lines a range *adds*, so pre-existing findings don't block a PR. */
export function scanAddedLines(range, cwd) {
  const diff = git(
    ["diff", "--unified=0", "--no-color", "--diff-filter=ACMR", range],
    cwd,
  );
  const violations = [];
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice("+++ b/".length);
      violations.push(...scanPath(path));
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    violations.push(...scanText(path, line.slice(1)));
  }
  return violations;
}

function main() {
  const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const rangeIndex = process.argv.indexOf("--range");
  const violations = scanTrackedFiles(cwd);
  if (rangeIndex !== -1) {
    const range = process.argv[rangeIndex + 1];
    if (!range) {
      throw new Error("--range needs a git range, e.g. origin/main...HEAD");
    }
    violations.push(...scanAddedLines(range, cwd));
  }

  if (violations.length === 0) {
    process.stdout.write("public hygiene: no violations\n");
    return;
  }
  // Deliberately prints the location and the rule, never the matched text: this
  // runs in a public CI log.
  for (const violation of violations) {
    const at = violation.line > 0 ? `:${violation.line}` : "";
    process.stderr.write(
      `${violation.path}${at} [${violation.rule}] ${violation.hint}\n`,
    );
  }
  process.stderr.write(`\n${violations.length} violation(s)\n`);
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  main();
}
