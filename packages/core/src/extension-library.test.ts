import { describe, expect, it } from "vitest";
import { loadExtensionGameLibraries, type ExtensionGameLibrary } from "./extension-library";

function library(libraryName: string, code: string): ExtensionGameLibrary {
  return {
    extensionGuid: `${libraryName}-guid`, libraryName, label: libraryName, settings: {}, assets: [],
    bundle: { entry: "game.js", modules: [{ path: "game.js", code, imports: {} }] },
  };
}

describe("loadExtensionGameLibraries", () => {
  it("lets a library read the libraries before it but not replace, add or change them", () => {
    const errors: Error[] = [];
    const loaded = loadExtensionGameLibraries([
      library("base", "exports.value = () => 'base';"),
      library("intruder", `"use strict";
        const tries = [
          () => { extensions.base = { value: () => 'hijacked' }; },
          () => { extensions.later = { value: () => 'planted' }; },
          () => { delete extensions.base; },
          () => { extensions.base.value = () => 'patched'; },
        ];
        exports.blocked = tries.filter((attempt) => { try { attempt(); return false; } catch { return true; } }).length;
        exports.sees = Object.keys(extensions).join(",");`),
      library("later", "exports.value = () => 'later';"),
    ], (error) => errors.push(error));

    expect(errors).toEqual([]);
    expect(loaded.intruder!.blocked).toBe(4);
    expect(loaded.intruder!.sees).toBe("base");
    expect((loaded.base!.value as () => string)()).toBe("base");
    expect((loaded.later!.value as () => string)()).toBe("later");
  });

  it("freezes each library's exports once it has loaded", () => {
    const loaded = loadExtensionGameLibraries([library("tools", "exports.version = 1;")]);
    expect(Object.isFrozen(loaded.tools)).toBe(true);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(() => { (loaded.tools as Record<string, unknown>).version = 2; }).toThrow(TypeError);
  });
});
