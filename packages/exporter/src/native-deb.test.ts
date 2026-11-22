import { describe, expect, it } from "vitest";
import { gunzipSync, strFromU8, strToU8, zipSync, type ZipOptions } from "fflate";
import { debianMaintainer, debianPackageName, debianVersion, packageLinuxDeb } from "./native-deb";
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
    appId: "com.example.spacegame",
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
  it("install the game under /opt named by its App ID, with a non-setuid sandbox helper, a command link and a menu entry", () => {
    const { fileName, bytes } = packageLinuxDeb(input());

    expect(fileName).toBe("Space_Game-Linux.deb");
    const members = arMembers(bytes);
    expect([...members.keys()]).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
    expect(strFromU8(members.get("debian-binary")!)).toBe("2.0\n");
    const control = tarRecords(gunzipSync(members.get("control.tar.gz")!));
    const controlText = strFromU8(control.get("./control")!.data);
    expect(controlText).toContain("Package: com.example.spacegame\nVersion: 1.2.0\nArchitecture: amd64\n");
    expect(controlText).toContain("\nMaintainer: Space Game <com.example.spacegame@haptic-game.invalid>\n");
    const depends = /^Depends: (.*)$/m.exec(controlText)![1]!.split(", ");
    // Every library Electron links, with the 64-bit time_t names Ubuntu 24.04 and Debian 13 use.
    for (const dependency of ["libgtk-3-0 | libgtk-3-0t64", "libnss3", "libasound2 | libasound2t64", "libgbm1", "libglib2.0-0 | libglib2.0-0t64"]) {
      expect(depends).toContain(dependency);
    }
    expect(controlText).toContain("\nRecommends: xdg-utils\n");
    expect(control.get("./postinst")!.mode).toBe(0o755);
    expect(control.get("./postrm")!.mode).toBe(0o755);
    const postinst = strFromU8(control.get("./postinst")!.data);
    expect(postinst).not.toContain("chmod");
    expect(postinst).toContain("PROFILE_SOURCE='/opt/com.example.spacegame/resources/apparmor-profile'\nPROFILE_TARGET='/etc/apparmor.d/com.example.spacegame'\n");
    expect(strFromU8(control.get("./postrm")!.data)).toContain("rm -f \"$PROFILE_TARGET\"");

    const data = tarRecords(gunzipSync(members.get("data.tar.gz")!));
    expect(data.get("./opt/com.example.spacegame/space-game")).toMatchObject({ mode: 0o755, type: "0", owner: "root" });
    expect(strFromU8(data.get("./opt/com.example.spacegame/space-game")!.data)).toBe("binary");
    expect(data.get("./opt/com.example.spacegame/chrome-sandbox")!.mode).toBe(0o755);
    expect(strFromU8(data.get("./opt/com.example.spacegame/resources/apparmor-profile")!.data))
      .toContain("profile com.example.spacegame /opt/com.example.spacegame/space-game flags=(unconfined) {\n  userns,\n");
    expect(data.get("./opt/com.example.spacegame/resources.pak")!.mode).toBe(0o644);
    expect(data.has("./opt/com.example.spacegame/resources/default_app.asar")).toBe(false);
    expect(strFromU8(data.get("./opt/com.example.spacegame/resources/game/index.html")!.data)).toBe("<html>");
    // A path over tar's 100 characters arrives whole through a GNU long name record.
    expect(data.has(`./opt/com.example.spacegame/resources/game/assets/${"deep/".repeat(30)}level.json`)).toBe(true);
    // Electron names the window's application ID after desktopName, which ties the window to the menu entry.
    expect(JSON.parse(strFromU8(data.get("./opt/com.example.spacegame/resources/app/package.json")!.data))).toMatchObject({
      hapticGameId: "project-guid", desktopName: "com.example.spacegame.desktop",
    });
    expect(data.get("./usr/bin/com.example.spacegame")).toMatchObject({ type: "2", link: "/opt/com.example.spacegame/space-game" });
    expect(strFromU8(data.get("./usr/share/applications/com.example.spacegame.desktop")!.data))
      .toContain("Name=Space Game\nExec=/opt/com.example.spacegame/space-game %U\nStartupWMClass=Space Game\nTerminal=false\n");
    // No App Icon: the entry names none and no icon is installed.
    expect([...data.keys()].filter((path) => path.startsWith("./usr/share/icons/hicolor/") && path.endsWith(".png"))).toEqual([]);
    // Each parent folder is its own record, so dpkg owns and removes it.
    expect(data.get("./opt/com.example.spacegame/resources/game/")).toMatchObject({ type: "5", mode: 0o755 });
  });

  it("install the App Icon in the hicolor theme at every size and name it in the menu entry", () => {
    const icon = appIconImages();
    const data = tarRecords(gunzipSync(arMembers(packageLinuxDeb(input({ name: "X", appId: "com.Studio.X", icon })).bytes).get("data.tar.gz")!));
    const icons = [...data.keys()].filter((path) => path.startsWith("./usr/share/icons/hicolor/") && path.endsWith(".png"));
    expect(icons).toEqual([16, 24, 32, 48, 64, 128, 256, 512].map((size) => `./usr/share/icons/hicolor/${size}x${size}/apps/com.studio.x.png`));
    expect(data.get("./usr/share/icons/hicolor/512x512/apps/com.studio.x.png")).toMatchObject({ mode: 0o644, data: icon.get(512) });
    expect(strFromU8(data.get("./usr/share/applications/com.studio.x.desktop")!.data)).toContain("Exec=/opt/com.studio.x/x %U\nIcon=com.studio.x\n");
    expect(JSON.parse(strFromU8(data.get("./opt/com.studio.x/resources/app/package.json")!.data)).desktopName).toBe("com.studio.x.desktop");
  });

  it("keep two games with the same title apart by their App IDs", () => {
    const paths = (appId: string) => [...tarRecords(gunzipSync(arMembers(packageLinuxDeb(input({ appId })).bytes).get("data.tar.gz")!)).keys()]
      .filter((path) => !path.endsWith("/") && !path.startsWith("./usr/share/icons/"));
    const first = paths("com.first.game");
    const second = new Set(paths("com.second.game"));
    expect(first.filter((path) => second.has(path))).toEqual([]);
  });

  it("use the project version when Debian accepts it, and name the package from a valid App ID only", () => {
    expect(debianVersion("2.4.0-beta.3")).toBe("2.4.0-beta.3");
    expect(debianVersion("v1")).toBe("0");
    expect(debianVersion("1.0 final")).toBe("0");
    expect(debianPackageName("com.Example.SpaceGame2")).toBe("com.example.spacegame2");
    expect(() => debianPackageName("com.my-studio.game")).toThrow("App ID com.my-studio.game is not valid. Set it in Project Settings > Export.");
    expect(() => packageLinuxDeb(input({ appId: "game" }))).toThrow("App ID game is not valid.");
    expect(() => packageLinuxDeb(input({ target: "windows-x64" }))).toThrow("Debian packages hold Linux games only.");
  });

  it("write a maintainer in Debian's Name <email> form with a placeholder address that cannot be delivered", () => {
    expect(debianMaintainer("Space <Game>, Deluxe\nEdition", "com.example.spacegame"))
      .toBe("Space Game Deluxe Edition <com.example.spacegame@haptic-game.invalid>");
    expect(debianMaintainer("  ", "com.example.x")).toBe("Game <com.example.x@haptic-game.invalid>");
  });
});
