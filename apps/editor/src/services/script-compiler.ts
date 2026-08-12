import type { SerializedGraph } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { defaultNodeRegistry, materializeLogicGraph } from "./graph-validation";

/**
 * Class a graph's compiled script binds to. Graphs are not yet owned by a
 * class asset, so the file name is the stable key until class ownership lands.
 */
export function classIdForGraphPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const base = file.replace(/\.graph\.(babasset|json)$/, "").replace(/\.babasset$/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, "_");
  return cleaned.length > 0 ? cleaned : "Graph";
}

export function compileGraphDocument(
  content: SerializedGraph | LogicGraph,
  options: { path: string; graphId?: string },
): ScriptBundleEntry | null {
  const graphId = options.graphId ?? "event-graph";
  const logic = materializeLogicGraph(content, graphId);
  if (logic.nodes.length === 0) return null;
  const compiled = compileGraph(logic, {
    assetGuid: options.path,
    registry: defaultNodeRegistry,
  });
  return {
    assetGuid: options.path,
    classId: classIdForGraphPath(options.path),
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

/** Scripts whose entry points bind to a lifecycle event get a live actor. */
export function spawnListForScripts(
  scripts: readonly ScriptBundleEntry[],
): Array<{ classId: string }> {
  const seen = new Set<string>();
  const spawn: Array<{ classId: string }> = [];
  for (const script of scripts) {
    if (!script.entryPoints.some((entry) => entry.event)) continue;
    if (seen.has(script.classId)) continue;
    seen.add(script.classId);
    spawn.push({ classId: script.classId });
  }
  return spawn;
}

export function compileGraphDocuments(
  documents: ReadonlyArray<{
    path: string;
    content: SerializedGraph | LogicGraph;
  }>,
): ScriptBundleEntry[] {
  const scripts: ScriptBundleEntry[] = [];
  for (const doc of documents) {
    try {
      const script = compileGraphDocument(doc.content, { path: doc.path });
      if (script) scripts.push(script);
    } catch (error) {
      // A graph that fails codegen must not stop Preview; the validator has
      // already surfaced the error in Compiler Results.
      console.error(`[play] failed to compile ${doc.path}`, error);
    }
  }
  return scripts;
}
