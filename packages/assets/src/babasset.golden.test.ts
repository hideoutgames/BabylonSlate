import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readGoldenBinary, writeGoldenBinary } from "@babylonslate/test-kit";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { bytesEqual } from "./bytes";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("babasset golden fixtures", () => {
  it("matches committed Graph v1 golden", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "00000000-0000-4000-8000-000000000001",
        type: "Graph",
        name: "Main",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        payload: { nodes: [], edges: [] },
      },
      chunks: [],
      blobThreshold: 1024 * 1024,
    });

    const relative = "__fixtures__/graph-v1.babasset";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, bytes);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(bytes, golden)).toBe(true);
    expect(readBabassetHeader(golden).type).toBe("Graph");
  });
});
