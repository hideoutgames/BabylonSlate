import { describe, expect, it } from "vitest";
import { gunzipSync, strFromU8, strToU8, zipSync, type ZipOptions } from "fflate";
import { debianPackageName, debianVersion, packageLinuxDeb } from "./native-deb";
import type { DesktopGamePackageInput } from "./native-desktop";
import { appIconImages } from "./test-support/app-icon-images";

const unix = (data: string, mode: number): [Uint8Array, ZipOptions] => [strToU8(data), { os: 3, attrs: mode << 16 }];

function input(overrides: Partial<DesktopGamePackageInput> = {}): DesktopGamePackageInput {
  return {
    target: "linux-x64",
    runtime: zipSync({
      electron: unix("binary", 0o100755),
      "chrome-sandbox": unix("sandbox", 0o100755),
      "resources.pak": unix("pak", 0o100644),
      "resources/default_app.asar": unix("sample", 0o100644),
    }),
    host: strToU8("host();"),
    game: new Map([["index.html", strToU8("<html>")], [`assets/${"deep/".repeat(30)}level.json`, strToU8("{}")]]),
    name: "Space Game",
    version: "1.2.0",
    gameId: "project-guid",
    ...overrides,
  };
}

/** The members of an `ar` archive. */
function arMembers(bytes: Uint8Array): Map<string, Uint8Array> {
  expect(strFromU8(bytes.subarray(0, 8))).toBe("!<arch>\n");
  const members = new Map<string, Uint8Array>();
  let offset = 8;
  while (offset < bytes.length) {
    const header = strFromU8(bytes.subarray(offset, offset + 60));
    const size = Number(header.slice(48, 58).trim());
    members.set(header.slice(0, 16).trim(), bytes.subarray(offset + 60, offset + 60 + size));
    offset += 60 + size + (size % 2);
  }
  return members;
}

interface TarRecord { mode: number; type: string; data: Uint8Array; link: string; owner: string }

/** Every record of a tar stream by path, with GNU long names applied. */
function tarRecords(bytes: Uint8Array): Map<string, TarRecord> {
  const records = new Map<string, TarRecord>();
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
    const field = (start: number, length: number) => strFromU8(bytes.subarray(offset + start, offset + start + length)).replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === "L") {
      longName = strFromU8(data).replace(/\0$/, "");
    } else {
      records.set(longName ?? field(0, 100), { mode: parseInt(field(100, 8), 8), type, data, link: field(157, 100), owner: field(265, 32) });
      longName = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return records;
}

describe("Linux Debian packages", () => {
  it("install the game under /opt with the sandbox helper setuid root, a command link and a menu entry", () => {
    const { fileName, bytes } = packageLinuxDeb(input());

    expect(fileName).toBe("Space_Game-Linux.deb");
    const members = arMembers(bytes);
    expect([...members.keys()]).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
    expect(strFromU8(members.get("debian-binary")!)).toBe("2.0\n");
    const control = tarRecords(gunzipSync(members.get("control.tar.gz")!));
    expect(strFromU8(control.get("./control")!.data)).toContain("Package: space-game\nVersion: 1.2.0\nArchitecture: amd64\n");
    expect(control.get("./postinst")!.mode).toBe(0o755);

    const data = tarRecords(gunzipSync(members.get("data.tar.gz")!));
    expect(data.get("./opt/space-game/space-game")).toMatchObject({ mode: 0o755, type: "0", owner: "root" });
    expect(strFromU8(data.get("./opt/space-game/space-game")!.data)).toBe("binary");
    expect(data.get("./opt/space-game/chrome-sandbox")!.mode).toBe(0o4755);
    expect(data.get("./opt/space-game/resources.pak")!.mode).toBe(0o644);
    expect(data.has("./opt/space-game/resources/default_app.asar")).toBe(false);
    expect(strFromU8(data.get("./opt/space-game/resources/game/index.html")!.data)).toBe("<html>");
    // A path over tar's 100 characters arrives whole through a GNU long name record.
    expect(data.has(`./opt/space-game/resources/game/assets/${"deep/".repeat(30)}level.json`)).toBe(true);
    // Electron names the window's application ID after desktopName, which ties the window to the menu entry.
    expect(JSON.parse(strFromU8(data.get("./opt/space-game/resources/app/package.json")!.data))).toMatchObject({
      hapticGameId: "project-guid", desktopName: "space-game.desktop",
    });
    expect(data.get("./usr/bin/space-game")).toMatchObject({ type: "2", link: "/opt/space-game/space-game" });
    expect(strFromU8(data.get("./usr/share/applications/space-game.desktop")!.data))
      .toContain("Name=Space Game\nExec=/opt/space-game/space-game %U\nStartupWMClass=Space Game\nTerminal=false\n");
    // No App Icon: the entry names none and no icon is installed.
    expect([...data.keys()].filter((path) => path.startsWith("./usr/share/icons/hicolor/") && path.endsWith(".png"))).toEqual([]);
    // Each parent folder is its own record, so dpkg owns and removes it.
    expect(data.get("./opt/space-game/resources/game/")).toMatchObject({ type: "5", mode: 0o755 });
  });

  it("install the App Icon in the hicolor theme at every size and name it in the menu entry", () => {
    const icon = appIconImages();
    const data = tarRecords(gunzipSync(arMembers(packageLinuxDeb(input({ name: "X", icon })).bytes).get("data.tar.gz")!));
    const icons = [...data.keys()].filter((path) => path.startsWith("./usr/share/icons/hicolor/") && path.endsWith(".png"));
    expect(icons).toEqual([16, 24, 32, 48, 64, 128, 256, 512].map((size) => `./usr/share/icons/hicolor/${size}x${size}/apps/x-game.png`));
    expect(data.get("./usr/share/icons/hicolor/512x512/apps/x-game.png")).toMatchObject({ mode: 0o644, data: icon.get(512) });
    expect(strFromU8(data.get("./usr/share/applications/x-game.desktop")!.data)).toContain("Exec=/opt/x-game/x %U\nIcon=x-game\n");
    // A one-letter command still matches the entry Debian installs as `x-game.desktop`.
    expect(JSON.parse(strFromU8(data.get("./opt/x-game/resources/app/package.json")!.data)).desktopName).toBe("x-game.desktop");
  });

  it("use the project version when Debian accepts it and keep package names at least two characters", () => {
    expect(debianVersion("2.4.0-beta.3")).toBe("2.4.0-beta.3");
    expect(debianVersion("v1")).toBe("0");
    expect(debianVersion("1.0 final")).toBe("0");
    expect(debianPackageName("x")).toBe("x-game");
    expect(debianPackageName("space-game")).toBe("space-game");
    expect(() => packageLinuxDeb(input({ target: "windows-x64" }))).toThrow("Debian packages hold Linux games only.");
  });
});
