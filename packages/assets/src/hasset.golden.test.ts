import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readGoldenBinary, writeGoldenBinary } from "@haptic/test-kit";
import { collectAssetDependencyMetadata } from "./asset-dependencies";
import { encodeHasset, readHassetHeader } from "./hasset";
import { bytesEqual } from "./bytes";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("hasset golden fixtures", () => {
  it("matches committed Class v1 golden", async () => {
    const payload = { nodes: [], edges: [] };
    const bytes = await encodeHasset({
      header: {
        ...collectAssetDependencyMetadata("Class", payload),
        guid: "00000000-0000-4000-8000-000000000001",
        type: "Class",
        name: "Main",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        payload,
      },
      chunks: [],
      blobThreshold: 1024 * 1024,
    });

    const relative = "__fixtures__/class-v1.hasset";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, bytes);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(bytes, golden)).toBe(true);
    expect(readHassetHeader(golden).type).toBe("Class");
  });
});
