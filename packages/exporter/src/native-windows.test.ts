import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import * as ResEdit from "resedit";
import type { DesktopGamePackageInput } from "./native-desktop";
import { packageWindowsGame, windowsFileVersion } from "./native-windows";
import { readZipEntries } from "./zip-merge";
import { appIconImages, pngHeader } from "./test-support/app-icon-images";

const EN_US = { lang: 1033, codepage: 1200 };

/** A stand-in for Electron's `electron.exe`: an empty executable with one icon group and Electron's version details. */
function electronExe(): Uint8Array {
  const exe = ResEdit.NtExecutable.createEmpty();
  const resources = ResEdit.NtExecutableResource.from(exe);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, [ResEdit.Data.RawIconItem.from(pngHeader(16), 16, 16, 32)]);
  const info = ResEdit.Resource.VersionInfo.create(1033, { fileVersionMS: 0x2c0009, fileVersionLS: 0x30000 }, [{ ...EN_US, values: {
    CompanyName: "GitHub, Inc.", FileDescription: "Electron", FileVersion: "44.9.3", InternalName: "electron.exe",
    LegalCopyright: "Copyright (C) 2015 GitHub, Inc. All rights reserved.", OriginalFilename: "electron.exe",
    ProductName: "Electron", ProductVersion: "44.9.3", SquirrelAwareVersion: "1",
  } }]);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(exe);
  return new Uint8Array(exe.generate());
}

function input(overrides: Partial<DesktopGamePackageInput> = {}): DesktopGamePackageInput {
  return {
    target: "windows-x64",
    runtime: zipSync({ "electron.exe": electronExe(), "resources.pak": strToU8("pak") }, { level: 9 }),
    host: strToU8("host();"),
    game: new Map([["index.html", strToU8("<html>")]]),
    name: "Space Game",
    version: "1.2.0-beta.3",
    gameId: "project-guid",
    ...overrides,
  };
}

function resourcesOf(executable: Uint8Array) {
  const resources = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(executable));
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  return { group: group!, info: info! };
}

describe("Windows game packages", () => {
  it("put the App Icon and the game's name and version into the executable", () => {
    const { fileName, bytes } = packageWindowsGame(input({ icon: appIconImages() }));

    expect(fileName).toBe("Space_Game-Windows.zip");
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      "Space Game/Space Game.exe", "Space Game/resources.pak", "Space Game/resources/app/main.cjs",
      "Space Game/resources/app/package.json", "Space Game/resources/game/index.html",
    ]);
    const { group, info } = resourcesOf(files["Space Game/Space Game.exe"]!);
    expect({ id: group.id, lang: group.lang, sizes: group.icons.map((icon) => icon.width) }).toEqual({ id: 1, lang: 1033, sizes: [16, 24, 32, 48, 64, 128, 0] });
    expect(info.getStringValues(EN_US)).toEqual({
      FileDescription: "Space Game", ProductName: "Space Game", ProductVersion: "1.2.0-beta.3", FileVersion: "1.2.0.0",
      InternalName: "Space Game.exe", OriginalFilename: "Space Game.exe", SquirrelAwareVersion: "1",
    });
    expect([info.fixedInfo.fileVersionMS, info.fixedInfo.fileVersionLS, info.fixedInfo.productVersionMS]).toEqual([0x10002, 0, 0x10002]);
  });

  it("copy the executable unchanged without an App Icon, as every other runtime file", () => {
    const source = input().runtime;
    const { bytes } = packageWindowsGame(input({ runtime: source }));
    const original = new Map(readZipEntries(source).map((entry) => [entry.name, entry]));
    const entries = new Map(readZipEntries(bytes).map((entry) => [entry.name, entry]));
    for (const [packaged, from] of [["Space Game/Space Game.exe", "electron.exe"], ["Space Game/resources.pak", "resources.pak"]] as const) {
      expect(entries.get(packaged)).toMatchObject({ compressedSize: original.get(from)!.compressedSize, crc: original.get(from)!.crc });
    }
    expect(resourcesOf(unzipSync(bytes)["Space Game/Space Game.exe"]!).info.getStringValues(EN_US).ProductName).toBe("Electron");
  });

  it("refuse a runtime without one icon group, and Linux targets", () => {
    const bare = ResEdit.NtExecutable.createEmpty();
    const runtime = zipSync({ "electron.exe": new Uint8Array(bare.generate()) });
    expect(() => packageWindowsGame(input({ runtime, icon: appIconImages() })))
      .toThrow("The Windows player is damaged: its executable's icon or version details are missing.");
    expect(() => packageWindowsGame(input({ target: "linux-x64" }))).toThrow("Windows packages hold Windows games only.");
  });

  it("number the file version from the project version's leading numbers", () => {
    expect(windowsFileVersion("1.2.3")).toEqual([1, 2, 3, 0]);
    expect(windowsFileVersion("v2.0.1.7-rc")).toEqual([2, 0, 1, 7]);
    expect(windowsFileVersion("Early Access")).toEqual([0, 0, 0, 0]);
    expect(windowsFileVersion("70000.4")).toEqual([0, 4, 0, 0]);
  });
});
