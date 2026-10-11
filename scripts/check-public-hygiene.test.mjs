import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanAddedLines,
  scanEventMetadata,
  scanText,
  scanTrackedFiles,
} from "./check-public-hygiene.mjs";

// Markers are assembled at runtime so this file does not itself contain a
// scannable shape.
const sessionLink = `https://app.${"devin"}.ai/sessions/0123456789abcdef`;
const team = ["DEVELOPMENT", "TEAM"].join("_");

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), "babylonslate-hygiene-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const commit = (file, contents) => {
    writeFileSync(join(directory, file), contents);
    git("add", file);
    git("commit", "--quiet", "-m", `Update ${file}`);
    return git("rev-parse", "HEAD");
  };
  return { directory, commit };
}

test("review bodies, review comments and issue comments are scanned", () => {
  assert.deepEqual(
    scanEventMetadata({
      pull_request: { title: "A change", body: "Summary" },
      review: { body: sessionLink },
    }).map((violation) => [violation.path, violation.rule]),
    [["pull-request:review", "agent-session-link"]],
  );
  assert.deepEqual(
    scanEventMetadata({
      pull_request: { title: "A change", body: "Summary" },
      comment: { body: sessionLink },
    }).map((violation) => [violation.path, violation.rule]),
    [["pull-request:comment", "agent-session-link"]],
  );
  assert.deepEqual(
    scanEventMetadata({
      issue: { title: "A bug" },
      comment: { body: sessionLink },
    }).map((violation) => [violation.path, violation.rule]),
    [["issue:comment", "agent-session-link"]],
  );
});

test("conditional Xcode signing settings are checked like plain ones", () => {
  for (const text of [
    `${team}[sdk=iphoneos*] = ABCDE12345;`,
    `"${team}[sdk=iphoneos*]" = ABCDE12345;`,
    `"${team}[config=Release][sdk=*]" = "ABCDE12345";`,
  ]) {
    assert.deepEqual(
      scanText("App.pbxproj", text).map((violation) => violation.rule),
      ["apple-signing-identity"],
      text,
    );
  }
  for (const text of [
    `"${team}[sdk=iphoneos*]" = "";`,
    `"${team}[sdk=iphoneos*]" = "$(APPLE_TEAM_ID)";`,
  ]) {
    assert.deepEqual(scanText("App.pbxproj", text), [], text);
  }
});

test("SVG and NUL-containing text are scanned in the tree and in each branch commit", (t) => {
  const { directory, commit } = repository(t);
  const base = commit("README.md", "Clean\n");
  commit("icon.svg", `<svg><!-- ${sessionLink} --></svg>\n`);
  commit("data.bin.txt", `header\0${sessionLink}\n`);
  assert.deepEqual(
    scanTrackedFiles(directory).map((violation) => violation.path).sort(),
    ["data.bin.txt", "icon.svg"],
  );

  // A link added and then removed on the branch is still reported.
  commit("notes.md", `${sessionLink}\n`);
  const removed = commit("notes.md", "Clean\n");
  const added = scanAddedLines(`${base}..${removed}`, directory);
  for (const file of ["icon.svg", "data.bin.txt", "notes.md"]) {
    assert.ok(
      added.some(
        (violation) =>
          violation.path.endsWith(`:${file}`) &&
          violation.rule === "agent-session-link",
      ),
      file,
    );
  }
});

test("the command line runs the scan when started through a differently named path", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "babylonslate-hygiene-entry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "hygiene-entry.mjs");
  try {
    symlinkSync(
      fileURLToPath(new URL("./check-public-hygiene.mjs", import.meta.url)),
      entry,
    );
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    t.skip("This host does not permit symbolic links");
    return;
  }
  // A missing option value is rejected before scanning, which proves main ran.
  const result = spawnSync(process.execPath, [entry, "--commits"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--commits needs a git range/);
});
