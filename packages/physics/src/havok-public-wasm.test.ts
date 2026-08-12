import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vendoredWasm = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/editor/public/havok/HavokPhysics.wasm",
);

describe("vendored editor Havok wasm", () => {
  it("ships HavokPhysics.wasm under editor public/ for offline Play", () => {
    expect(existsSync(vendoredWasm)).toBe(true);
    const bytes = readFileSync(vendoredWasm);
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(bytes.byteLength).toBeGreaterThan(100_000);
  });
});
