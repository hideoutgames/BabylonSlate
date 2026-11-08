import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readZipEntries } from "../../../packages/exporter/src/zip-merge";
import { isRuntimeFileName, ownRuntimeZip } from "./game-runtime";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function install(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "haptic-runtime-"));
  await mkdir(join(dir, "locales"));
  await mkdir(join(dir, "resources"));
  await writeFile(join(dir, "babylonslate"), "editor binary");
  await chmod(join(dir, "babylonslate"), 0o755);
  await writeFile(join(dir, "libffmpeg.so"), "codec");
  await chmod(join(dir, "libffmpeg.so"), 0o755);
  await writeFile(join(dir, "resources.pak"), "pak");
  await chmod(join(dir, "resources.pak"), 0o644);
  await writeFile(join(dir, "locales/en-US.pak"), "en");
  await writeFile(join(dir, "resources/app.asar"), "the editor itself");
  return dir;
}

describe("The desktop app's own runtime", () => {
  it("zips the release's files from the install folder under the release names, keeping Unix modes and leaving the editor out", async () => {
    const root = await install();
    const zip = await ownRuntimeZip({
      installDir: root, executablePath: join(root, "babylonslate"), platform: "linux",
      files: ["electron", "libffmpeg.so", "resources.pak", "locales/en-US.pak", "resources/default_app.asar"],
    });

    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["electron", "libffmpeg.so", "resources.pak", "locales/en-US.pak"]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const content = (name: string) => {
      const entry = byName.get(name)!;
      const start = entry.localOffset + 30 + new DataView(zip.buffer).getUint16(entry.localOffset + 26, true);
      return inflateRawSync(zip.subarray(start, start + entry.compressedSize)).toString();
    };
    expect(content("electron")).toBe("editor binary");
    expect(content("locales/en-US.pak")).toBe("en");
    expect(byName.get("electron")!.externalAttributes >>> 16).toBe(0o100755);
    expect(byName.get("resources.pak")!.externalAttributes >>> 16).toBe(0o100644);
  });

  it("refuses a missing runtime file, a list without the executable and names that leave the install folder", async () => {
    const root = await install();
    const base = { installDir: root, executablePath: join(root, "babylonslate"), platform: "linux" as const };
    await expect(ownRuntimeZip({ ...base, files: ["electron", "libGLESv2.so"] })).rejects.toThrow("This desktop app is missing a runtime file: libGLESv2.so. Reinstall Haptic.");
    await expect(ownRuntimeZip({ ...base, files: ["resources.pak"] })).rejects.toThrow("The runtime file list has no electron.");
    await expect(ownRuntimeZip({ ...base, platform: "darwin", files: ["electron"] })).rejects.toThrow("cannot package games for darwin");
    for (const name of ["../secret", "/etc/passwd", "a\\b", "C:/x", "locales//x", "./electron", ""]) {
      expect(isRuntimeFileName(name)).toBe(false);
    }
    await expect(ownRuntimeZip({ ...base, files: ["electron", "../secret"] })).rejects.toThrow("Invalid runtime file list.");
  });
});
