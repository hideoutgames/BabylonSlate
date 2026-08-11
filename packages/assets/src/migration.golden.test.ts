import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGoldenBinary, writeGoldenBinary } from "@babylonslate/test-kit";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { loadPayloadWithMigration } from "./migrate-on-load";
import { createDefaultMigrationRegistry } from "./migration";
import { bytesEqual } from "./bytes";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("historical migration goldens", () => {
  it("migrates Graph v0 golden payload to current", async () => {
    const registry = createDefaultMigrationRegistry();
    // v0 graph babasset: version 0, empty payload (pre-nodes/edges default).
    const v0 = await encodeBabasset({
      header: {
        guid: "00000000-0000-4000-8000-0000000000a0",
        type: "Graph",
        name: "Legacy",
        engineVersion: "0.0.0",
        version: 0,
        mode: "thin",
        dependencies: [],
        payload: {},
      },
      chunks: [],
      blobThreshold: 1024 * 1024,
    });
    const relative = "__fixtures__/graph-v0.babasset";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, v0);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(v0, golden)).toBe(true);
    const header = readBabassetHeader(golden);
    expect(header.version).toBe(0);

    const loaded = loadPayloadWithMigration(registry, {
      type: "Graph",
      version: header.version,
      payload: header.payload,
      path: "assets/legacy.graph.babasset",
    });
    expect(loaded.pending).not.toBeNull();
    expect(loaded.version).toBe(1);
    expect(loaded.payload.nodes).toEqual([]);
    expect(loaded.payload.edges).toEqual([]);
  });

  it("does not silently mark current assets as pending migration", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "Graph",
      version: 1,
      payload: { nodes: [], edges: [] },
      path: "x",
    });
    expect(loaded.pending).toBeNull();
  });
});
