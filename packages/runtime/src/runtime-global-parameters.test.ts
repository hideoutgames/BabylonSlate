import { describe, expect, it } from "vitest";
import { RuntimeGlobalParameters } from "./runtime-global-parameters";

const catalog = {
  fx: [
    { id: "heat", name: "Heat", type: "float", defaultValue: [1] },
    { id: "wind", name: "Wind", type: "vec2", defaultValue: [0, 0] },
  ],
};

describe("runtime global parameters", () => {
  it("reads defaults, sets values sized to their type and checks the node's types", () => {
    const warnings: string[] = [];
    const globals = new RuntimeGlobalParameters((message) => warnings.push(message));
    globals.replaceCatalog(catalog);
    expect(globals.get("fx", "Heat", ["float"])).toEqual({ found: true, value: [1] });
    expect(globals.set("fx", " Wind ", [3, 4, 5], ["vec2", "vec3"])?.id).toBe("wind");
    expect(globals.get("fx", "Wind", ["vec2", "vec3"])).toEqual({ found: true, value: [3, 4] });
    // A Float node cannot set a Vector parameter, and unknown names do nothing; each warns once.
    expect(globals.set("fx", "Wind", [1], ["float"])).toBeNull();
    expect(globals.set("fx", "Missing", [1], ["float"])).toBeNull();
    expect(globals.set("fx", "Missing", [2], ["float"])).toBeNull();
    expect(globals.get("other", "Heat", ["float"])).toEqual({ found: false, value: [] });
    expect(warnings).toHaveLength(3);
  });

  it("keeps values across a Scene's catalog and drops those whose parameter changed", () => {
    const globals = new RuntimeGlobalParameters();
    globals.replaceCatalog(catalog);
    globals.set("fx", "Heat", [5], ["float"]);
    globals.set("fx", "Wind", [1, 2], ["vec2"]);
    // A streamed Scene lists only its own collections; the others stay.
    globals.mergeCatalog({ more: [{ id: "glow", name: "Glow", type: "color", defaultValue: [1, 1, 1, 1] }] });
    expect(globals.get("fx", "Heat", ["float"]).value).toEqual([5]);
    // Wind became a Vector3: its Vector2 value no longer fits.
    globals.mergeCatalog({ fx: [catalog.fx[0], { id: "wind", name: "Wind", type: "vec3", defaultValue: [0, 0, 1] }] });
    expect(globals.get("fx", "Wind", ["vec3"]).value).toEqual([0, 0, 1]);
    expect(globals.get("more", "Glow", ["color"]).found).toBe(true);
  });

  it("tells the renderer about every value it sets or drops", () => {
    const commands: unknown[] = [];
    const globals = new RuntimeGlobalParameters(undefined, (command) => commands.push(command));
    globals.replaceCatalog(catalog);
    globals.set("fx", "Wind", [3, 4, 5], ["vec2", "vec3"]);
    globals.set("fx", "Missing", [1], ["float"]);
    // Wind becomes a Vector3, so the renderer drops its Vector2 value too.
    globals.mergeCatalog({ fx: [catalog.fx[0], { id: "wind", name: "Wind", type: "vec3", defaultValue: [0, 0, 1] }] });
    expect(commands).toEqual([
      { type: "setGlobalParameter", collectionGuid: "fx", parameterId: "wind", value: [3, 4] },
      { type: "setGlobalParameter", collectionGuid: "fx", parameterId: "wind", value: null },
    ]);
  });
});
