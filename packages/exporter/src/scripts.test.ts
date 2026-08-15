import { describe, expect, it } from "vitest";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  concatenateScripts,
  parseScriptRegistry,
  serializeScriptRegistry,
} from "./scripts";

function script(partial: Partial<ScriptBundleEntry> & Pick<ScriptBundleEntry, "classId" | "source">): ScriptBundleEntry {
  return {
    assetGuid: partial.assetGuid ?? partial.classId,
    anchors: partial.anchors ?? [
      {
        line: 1,
        column: 0,
        assetGuid: partial.assetGuid ?? partial.classId,
        graphId: "event-graph",
        nodeId: "n1",
      },
    ],
    entryPoints: partial.entryPoints ?? [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
    ...partial,
  };
}

describe("concatenated scripts", () => {
  it("rewrites anchor lines by the concatenation offset", () => {
    const first = script({ classId: "A", source: "export function a() {}\n" });
    const second = script({
      classId: "B",
      source: "export function b() {}\n",
      anchors: [
        { line: 1, column: 0, assetGuid: "B", graphId: "event-graph", nodeId: "n2" },
      ],
    });
    const bundled = concatenateScripts([first, second]);
    const offset = bundled.source.split("\n").length - second.source.split("\n").length;
    expect(bundled.scripts[1]?.anchors[0]?.line).toBeGreaterThan(1);
    expect(bundled.scripts[1]?.anchors[0]?.line).toBe(1 + offset);
  });

  it("round-trips a script registry file the player can eval", () => {
    const entries = [script({ classId: "Hero", source: "export function onBeginPlay() {}" })];
    const file = serializeScriptRegistry(entries);
    expect(file.startsWith("globalThis.__babylonslateScripts = ")).toBe(true);
    const parsed = parseScriptRegistry(file);
    expect(parsed[0]?.classId).toBe("Hero");
    expect(parsed[0]?.source).toContain("onBeginPlay");
  });

  it("parses a registry after a concatenated source prefix", () => {
    const entries = [script({ classId: "Hero", source: "export function onBeginPlay() {}\n" })];
    const bundled = concatenateScripts(entries);
    const file = `${bundled.source}\n${serializeScriptRegistry(entries)}`;
    const parsed = parseScriptRegistry(file);
    expect(parsed[0]?.classId).toBe("Hero");
    expect(parsed[0]?.anchors[0]?.line).toBe(1);
  });
});
