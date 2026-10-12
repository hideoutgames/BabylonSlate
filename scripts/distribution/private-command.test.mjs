import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateCommand } from "./private-command.mjs";

test("private command failures expose a sanitized stage, never child diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-private-test-"));
  try {
    await assert.rejects(privateCommand(process.execPath, ["-e", "process.stderr.write('sensitive fixture'); process.exit(1)"], { directory, stage: "signing" }), error => error.message === "Apple signing failed; private diagnostics were not published");
    assert.match(await readFile(join(directory, "signing.stderr"), "utf8"), /sensitive fixture/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a timed-out command also stops the processes it started", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-private-test-"));
  try {
    const marker = join(directory, "descendant-ran");
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 1500)`;
    const command = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    await assert.rejects(privateCommand(process.execPath, ["-e", command], { directory, stage: "archive", timeoutMs: 500 }), error => error.message === "Apple archive failed; private diagnostics were not published");
    await delay(2000);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
