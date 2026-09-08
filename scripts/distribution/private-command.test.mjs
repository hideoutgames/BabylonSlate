import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCommand } from "./private-command.mjs";

test("private command failures expose a sanitized stage, never child diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-private-test-"));
  try {
    await assert.rejects(privateCommand(process.execPath, ["-e", "process.stderr.write('sensitive fixture'); process.exit(1)"], { directory, stage: "signing" }), error => error.message === "Apple signing failed; private diagnostics were not published");
    assert.match(await readFile(join(directory, "signing.stderr"), "utf8"), /sensitive fixture/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
