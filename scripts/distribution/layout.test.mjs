import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRenderer } from "../../apps/desktop/scripts/layout.mjs";

test("staging preserves runtime assets while omitting deployment markers and credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "distribution-layout-"));
  try {
    const source = join(root, "dist");
    for (const file of [
      "index.html",
      "player/index.html",
      "assets/worker.js",
      "assets/physics.wasm",
      "engine-plugins/catalog.json",
      "branding/logo.png",
      "build-manifest.json",
      ".nojekyll",
      "ktx2/.keep",
      "player/ktx2/.keep",
      "assets/.gitkeep",
    ]) {
      await mkdir(join(source, file, ".."), { recursive: true });
      await writeFile(join(source, file), "fixture");
    }
    await writeFile(join(root, ".env"), "private fixture");
    await stageRenderer(source, join(root, "staged"));
    assert.equal(await readFile(join(root, "staged/assets/physics.wasm"), "utf8"), "fixture");
    assert.equal(await readFile(join(root, "staged/player/index.html"), "utf8"), "fixture");
    assert.equal((await readdir(join(root, "staged"))).includes(".env"), false);
    assert.equal((await readdir(join(root, "staged"))).includes(".nojekyll"), false);
    assert.equal((await readdir(join(root, "staged/ktx2"))).includes(".keep"), false);
    assert.equal((await readdir(join(root, "staged/player/ktx2"))).includes(".keep"), false);
    assert.equal((await readdir(join(root, "staged/assets"))).includes(".gitkeep"), false);
    await writeFile(join(source, "credential.p8"), "private fixture");
    await assert.rejects(
      stageRenderer(source, join(root, "rejected")),
      /Forbidden private file or symlink in renderer output: credential\.p8/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
