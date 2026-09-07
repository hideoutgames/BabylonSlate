import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserServer } from "./browser-server.mjs";

test("concurrent servers own distinct ports, artifacts, and identity nonces", async (t) => {
  const directories = await Promise.all(
    [1, 2].map(() => mkdtemp(join(tmpdir(), "owned browser server "))),
  );
  t.after(() =>
    Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );
  for (const [index, directory] of directories.entries())
    await writeFile(
      join(directory, "index.html"),
      `<html><body>${index}</body></html>`,
    );
  const servers = [];
  try {
    for (const [index, directory] of directories.entries())
      servers.push(await startBrowserServer(directory, { key: String(index) }));
    assert.notEqual(servers[0].url, servers[1].url);
    assert.notEqual(servers[0].nonce, servers[1].nonce);
    for (const [index, server] of servers.entries()) {
      assert.equal(
        await (await fetch(server.url)).text(),
        `<html><body>${index}</body></html>`,
      );
      assert.deepEqual(
        await (await fetch(`${server.url}/__test_identity`)).json(),
        { key: String(index), nonce: server.nonce },
      );
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
  await assert.rejects(fetch(servers[0].url));
});
