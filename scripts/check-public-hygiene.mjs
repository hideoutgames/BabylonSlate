#!/usr/bin/env node
// Rejects things that must never appear in a public repository: links to agent
// sessions (outside pull-request descriptions), credential markers, and
// developer-specific Apple signing identifiers.
//
// gitleaks (.gitleaks.toml) covers generic high-entropy credentials. This check
// covers the repository's own policy, which gitleaks has no notion of, and runs
// anywhere Node runs — no macOS, no Xcode, no network.
//
// Usage:
//   node scripts/check-public-hygiene.mjs                 # tracked files at HEAD
//   node scripts/check-public-hygiene.mjs --range A..B     # + lines each commit in A..B adds
//   node scripts/check-public-hygiene.mjs --event E.json   # + issue/pull-request event text
//   node scripts/check-public-hygiene.mjs --commits A..B   # + commit messages

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

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
    id: "agent-request-attribution",
    regex: /co-authored-by:\s*(?:devin|cursor|copilot)|requested by:\s*@/i,
    hint: "Remove the agent/requester attribution footer.",
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
    // needed for a simulator build; see SECURITY.md. A complete quoted Xcode
    // variable reference carries no identifier; literal prefixes/suffixes do.
    // Conditional settings such as `"DEVELOPMENT_TEAM[sdk=iphoneos*]" = …` are
    // checked like the plain setting.
    regex:
      /\b(?:DEVELOPMENT_TEAM|PROVISIONING_PROFILE|PROVISIONING_PROFILE_SPECIFIER)\b(?:\[[^\]\n]*\])*"?\s*=\s*(?!""|;|"\$\([A-Za-z_][A-Za-z0-9_]*\)"\s*(?:;|$))\S/,
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

/**
 * Pull-request descriptions may link the agent session that produced them; the
 * link grants no access by itself. Tracked content, commit messages, titles, and
 * comments still reject it.
 */
export const pullRequestBodyAllowedRules = new Set(["agent-session-link"]);

/** @returns {{path: string, line: number, rule: string, hint: string}[]} */
export function scanText(path, text, allowedRules = new Set()) {
  if (selfReferentialPaths.has(path)) {
    return [];
  }
  const violations = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of contentRules) {
      if (allowedRules.has(rule.id)) continue;
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

function git(args, cwd, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer });
}

export function trackedFiles(cwd) {
  return git(["ls-files", "-z"], cwd).split("\0").filter(Boolean);
}

/**
 * Only known binary formats skip content rules. Text that merely contains a NUL
 * byte (or an SVG) is still scanned, so a link cannot hide behind one.
 */
export function isProbablyBinary(path) {
  return binaryExtensions.has(extname(path).toLowerCase());
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
    if (isProbablyBinary(path)) {
      continue;
    }
    violations.push(...scanText(path, text));
  }
  return violations;
}

/**
 * Scans the lines each commit in `A..B` adds (`A...B` is read the same way), so
 * pre-existing findings don't block a PR, while content added by one commit and
 * removed by a later one is still caught. NUL-containing text is diffed as text;
 * known binary formats are left out.
 */
export function scanAddedLines(range, cwd) {
  const commits = git(
    ["rev-list", "--reverse", "--no-merges", range.replace("...", "..")],
    cwd,
  )
    .split("\n")
    .filter(Boolean);
  return commits.flatMap((commit) =>
    scanCommitPatch(
      commit,
      git(
        [
          "-c",
          "core.quotePath=false",
          "show",
          "--patch",
          "--text",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          "--diff-filter=ACMR",
          "--format=",
          commit,
          "--",
          ".",
          ...[...binaryExtensions].map(
            (extension) => `:(exclude,icase)*${extension}`,
          ),
        ],
        cwd,
        // One commit at a time; a large generated file must not abort the scan.
        256 * 1024 * 1024,
      ),
    ),
  );
}

function scanCommitPatch(commit, patch) {
  const violations = [];
  const at = (violation) => ({
    ...violation,
    path: `commit:${commit}:${violation.path}`,
  });
  let path = "";
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      path = "";
      continue;
    }
    if (inHeader) {
      const target = /^(?:\+\+\+ "?b\/|rename to |copy to )(.*?)"?$/.exec(line);
      if (target) {
        path = target[1];
        violations.push(...scanPath(path).map(at));
      } else if (line.startsWith("@@")) {
        inHeader = false;
      }
      continue;
    }
    if (line.startsWith("+")) {
      violations.push(...scanText(path, line.slice(1)).map(at));
    }
  }
  return violations;
}

export function scanEventMetadata(event) {
  const violations = [];
  if (event.pull_request) {
    violations.push(
      ...scanText("pull-request:title", event.pull_request.title ?? ""),
      ...scanText(
        "pull-request:body",
        event.pull_request.body ?? "",
        pullRequestBodyAllowedRules,
      ),
    );
  }
  if (event.review) {
    violations.push(...scanText("pull-request:review", event.review.body ?? ""));
  }
  if (event.comment) {
    // Pull-request review comments carry `pull_request`; issue comments carry
    // `issue`, which has `pull_request` only when the issue is a pull request.
    const location =
      event.pull_request || event.issue?.pull_request
        ? "pull-request:comment"
        : "issue:comment";
    violations.push(...scanText(location, event.comment.body ?? ""));
  }
  return violations;
}

export function scanCommitMessages(range, cwd) {
  const output = git(["log", "--format=%H%x00%B%x00", range], cwd);
  const fields = output.split("\0");
  const violations = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = fields[index]?.trim();
    const message = fields[index + 1] ?? "";
    if (commit) violations.push(...scanText(`commit:${commit}`, message));
  }
  return violations;
}

function option(name, hint) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs ${hint}`);
  return value;
}

function main() {
  // Validate arguments before the slow tracked-tree scan.
  const range = option("--range", "a git range, e.g. origin/main..HEAD");
  const eventPath = option("--event", "a GitHub event JSON path");
  const commits = option("--commits", "a git range");
  const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const violations = scanTrackedFiles(cwd);
  if (range) violations.push(...scanAddedLines(range, cwd));
  if (eventPath) {
    violations.push(
      ...scanEventMetadata(JSON.parse(readFileSync(eventPath, "utf8"))),
    );
  }
  if (commits) violations.push(...scanCommitMessages(commits, cwd));

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

/** Compares resolved file URLs, so Windows paths and symlinked entries still run the check. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
