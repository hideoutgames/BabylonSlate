import { describe, expect, it } from "vitest";
import { gitBlobSha1, lfsObjectId, lfsPointerText, parseLfsPointer, sha256Hex } from "./lfs-pointer";

// Expected ids come from `git hash-object` and `sha256sum`, not from the code under test.
const ASSET_BYTES = new Uint8Array([...new TextEncoder().encode("HAPTIC"), 0, 1, 2, ...new TextEncoder().encode("asset")]);
const ASSET_BLOB = "8fa82edd91065e97da25c6af05fdd0637b923607";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const OID = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`;

describe("LFS pointers", () => {
  it("hashes content as a Git blob and as an LFS object", async () => {
    expect(await gitBlobSha1(ASSET_BYTES)).toBe(ASSET_BLOB);
    expect(await gitBlobSha1(new Uint8Array())).toBe(EMPTY_BLOB);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("writes the pointer Git stores for an LFS object and names objects only under .blobs", () => {
    expect(lfsPointerText(OID, 12345)).toBe(POINTER);
    expect(lfsObjectId(`assets/.blobs/${OID}`)).toBe(OID);
    expect(lfsObjectId(`plugin/content/.blobs/${OID}`)).toBe(OID);
    expect(lfsObjectId(`assets/blobs/${OID}`)).toBeNull();
    expect(lfsObjectId(`assets/.blobs/${OID.slice(1)}`)).toBeNull();
  });

  it("reads back exactly the pointer it writes and nothing else", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(parseLfsPointer(encode(POINTER))).toEqual({ oid: OID, size: 12345 });
    expect(parseLfsPointer(encode(POINTER.replace("size 12345", "size 0")))).toEqual({ oid: OID, size: 0 });
    for (const other of [
      POINTER.trimEnd(),
      POINTER.replace("sha256:", "sha1:"),
      POINTER.replace("size 12345", "size 012"),
      POINTER.replace(OID, OID.toUpperCase()),
      `${POINTER}extra`,
    ]) expect(parseLfsPointer(encode(other))).toBeNull();
    expect(parseLfsPointer(new Uint8Array(4096))).toBeNull();
  });
});
