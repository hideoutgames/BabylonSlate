import { describe, expect, it } from "vitest";
import { mapOf, STRING, FLOAT } from "@babylonslate/scripting";
import { mapNodes } from "./map";

describe("map nodes", () => {
  it("exports get/set/has/remove/size/keys with map wildcards", () => {
    const ids = mapNodes.map((node) => node.id);
    expect(ids).toEqual([
      "map.get",
      "map.set",
      "map.has",
      "map.remove",
      "map.size",
      "map.keys",
    ]);
    expect(mapNodes.every((node) => node.category === "map")).toBe(true);
    const getPins = mapNodes[0]!.pins({});
    const mapPin = getPins.find((pin) => pin.id === "map");
    expect(mapPin?.type).toEqual(
      mapOf(
        { kind: "resolvingWildcard", group: "K" },
        { kind: "resolvingWildcard", group: "V" },
      ),
    );
    void STRING;
    void FLOAT;
  });
});
