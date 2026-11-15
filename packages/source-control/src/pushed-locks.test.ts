import { describe, expect, it } from "vitest";
import { pushedPaths, type LocalFiles } from "./pushed-locks";

// Expected ids come from `git hash-object`, not from the code under test.
const ASSET_BYTES = new Uint8Array([...new TextEncoder().encode("HAPTIC"), 0, 1, 2, ...new TextEncoder().encode("asset")]);
const ASSET_BLOB = "8fa82edd91065e97da25c6af05fdd0637b923607";
const OID = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
/** `git hash-object` of the LFS pointer for OID at 12345 bytes. */
const POINTER_BLOB = "60c8d8ab2adcf57a391163a7eeb0cdb8bf348e44";

function files(entries: Record<string, Uint8Array | number>) {
  const reads: string[] = [];
  const local: LocalFiles = {
    async read(path) {
      reads.push(`read ${path}`);
      const value = entries[path];
      return value instanceof Uint8Array ? value : null;
    },
    async size(path) {
      reads.push(`size ${path}`);
      const value = entries[path];
      return typeof value === "number" ? value : null;
    },
  };
  return { local, reads };
}

describe("pushed-lock comparator", () => {
  it("counts a file pushed only when its blob id equals the remote's", async () => {
    const { local, reads } = files({
      "assets/a.hasset": ASSET_BYTES,
      "assets/changed.hasset": new Uint8Array([1, 2, 3]),
      "assets/unpushed.hasset": ASSET_BYTES,
      "assets/deleted.hasset": 0,
    });
    const remote = new Map([
      ["assets/a.hasset", ASSET_BLOB],
      ["assets/changed.hasset", ASSET_BLOB],
      ["assets/deleted.hasset", ASSET_BLOB],
    ]);
    const pushed = await pushedPaths(
      ["assets/a.hasset", "assets/changed.hasset", "assets/unpushed.hasset", "assets/deleted.hasset", "assets/a.hasset"],
      remote,
      local,
    );
    expect([...pushed]).toEqual(["assets/a.hasset"]);
    // A path the remote lacks is never read, and each path is read once.
    expect(reads).toEqual(["read assets/a.hasset", "read assets/changed.hasset", "read assets/deleted.hasset"]);
  });

  it("compares an LFS object by its pointer's blob id, from its name and size alone", async () => {
    const path = `assets/.blobs/${OID}`;
    const { local, reads } = files({ [path]: 12345 });
    expect([...await pushedPaths([path], new Map([[path, POINTER_BLOB]]), local)]).toEqual([path]);
    expect(reads).toEqual([`size ${path}`]);
    const shorter = files({ [path]: 12344 });
    expect(await pushedPaths([path], new Map([[path, POINTER_BLOB]]), shorter.local)).toEqual(new Set());
    const missing = files({});
    expect(await pushedPaths([path], new Map([[path, POINTER_BLOB]]), missing.local)).toEqual(new Set());
  });
});
