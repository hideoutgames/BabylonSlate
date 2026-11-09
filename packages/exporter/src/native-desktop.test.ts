import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync, type ZipOptions } from "fflate";
import { desktopGameNames, packageDesktopGame, type DesktopGamePackageInput } from "./native-desktop";
import { readZipEntries } from "./zip-merge";

const EXECUTABLE_MODE = 0o100755;
const FILE_MODE = 0o100644;

/** A stand-in for Electron's release zip: Unix modes as the Linux release records them. */
function runtime(executable: string): Uint8Array {
  const unix = (data: string, mode: number): [Uint8Array, ZipOptions] => [strToU8(data), { os: 3, attrs: mode << 16 }];
  return zipSync({
    [executable]: unix("binary", EXECUTABLE_MODE),
    "chrome-sandbox": unix("sandbox", EXECUTABLE_MODE),
    "resources.pak": unix("pak", FILE_MODE),
    "resources/default_app.asar": unix("sample", FILE_MODE),
    "LICENSES.chromium.html": unix("licences", FILE_MODE),
  }, { level: 9 });
}

function input(overrides: Partial<DesktopGamePackageInput> = {}): DesktopGamePackageInput {
  return {
    target: "linux-x64",
    runtime: runtime("electron"),
    host: strToU8("host();"),
    game: new Map([["index.html", strToU8("<html>")], ["assets/game.js", strToU8("play();")]]),
    name: "Space Game",
    version: "1.2.0",
    gameId: "project-guid",
    ...overrides,
  };
}

describe("Desktop game packages", () => {
  it("wrap the web game in the Linux runtime under one folder, keeping each runtime file's bytes and mode", () => {
    const source = runtime("electron");
    const { fileName, bytes } = packageDesktopGame(input({ runtime: source }));

    expect(fileName).toBe("Space_Game-Linux.zip");
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      "Space Game/LICENSES.chromium.html",
      "Space Game/chrome-sandbox",
      "Space Game/resources.pak",
      "Space Game/resources/app/main.cjs",
      "Space Game/resources/app/package.json",
      "Space Game/resources/game/assets/game.js",
      "Space Game/resources/game/index.html",
      "Space Game/space-game",
    ]);
    expect(strFromU8(files["Space Game/space-game"]!)).toBe("binary");
    expect(JSON.parse(strFromU8(files["Space Game/resources/app/package.json"]!))).toEqual({
      name: "space-game", productName: "Space Game", version: "1.2.0", main: "main.cjs", hapticGameId: "project-guid",
    });
    const entries = new Map(readZipEntries(bytes).map((entry) => [entry.name, entry]));
    const original = new Map(readZipEntries(source).map((entry) => [entry.name, entry]));
    // Copied, not recompressed: same compressed size and CRC, and the Unix mode that makes it runnable.
    expect(entries.get("Space Game/space-game")).toMatchObject({
      compressedSize: original.get("electron")!.compressedSize, crc: original.get("electron")!.crc,
    });
    expect(entries.get("Space Game/space-game")!.externalAttributes >>> 16).toBe(EXECUTABLE_MODE);
    expect(entries.get("Space Game/chrome-sandbox")!.externalAttributes >>> 16).toBe(EXECUTABLE_MODE);
    expect(entries.get("Space Game/resources.pak")!.externalAttributes >>> 16).toBe(FILE_MODE);
  });

  it("name the Windows executable after the project, without characters Windows refuses", () => {
    expect(desktopGameNames("Rocket: Run.", "windows-x64")).toEqual({ folder: "Rocket Run", executable: "Rocket Run.exe", archive: "Rocket_Run-Windows.zip" });
    const files = unzipSync(packageDesktopGame(input({ target: "windows-x64", runtime: runtime("electron.exe") })).bytes);
    expect(Object.keys(files)).toContain("Space Game/Space Game.exe");
    expect(Object.keys(files)).not.toContain("Space Game/electron.exe");
  });

  it("write the rewritten executable once, from the runtime's original bytes, keeping its mode", () => {
    const seen: string[] = [];
    const { bytes } = packageDesktopGame(input(), (executable) => {
      seen.push(strFromU8(executable));
      return strToU8("branded");
    });
    expect(seen).toEqual(["binary"]);
    expect(strFromU8(unzipSync(bytes)["Space Game/space-game"]!)).toBe("branded");
    const executables = readZipEntries(bytes).filter((entry) => entry.name === "Space Game/space-game");
    expect(executables.map((entry) => entry.externalAttributes >>> 16)).toEqual([EXECUTABLE_MODE]);
  });

  it("refuse a runtime without its executable and a game path that leaves the game folder", () => {
    expect(() => packageDesktopGame(input({ target: "windows-x64" }))).toThrow("The Windows player is damaged: electron.exe is missing.");
    expect(() => packageDesktopGame(input({ game: new Map([["../escape.js", strToU8("x")]]) }))).toThrow("Invalid game file path: ../escape.js");
  });
});
