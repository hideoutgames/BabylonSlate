import type { SerializedGraph } from "@babylonslate/core";
import type {
  ScriptBundleEntry,
  ScriptConsoleCommand,
} from "@babylonslate/bridge";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { defaultNodeRegistry, materializeLogicGraph } from "./graph-validation";

const ACTOR_LIFECYCLE_EVENTS = new Set(["onBeginPlay", "onTick"]);
const PARAM_TYPES = new Set(["string", "float", "int", "bool", "enum"]);

/**
 * Class a graph's compiled script binds to. Class (and legacy Graph) files
 * use the file stem as the stable key.
 */
export function classIdForGraphPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const base = file
    .replace(/\.(graph|class|ui)\.(babasset|json)$/, "")
    .replace(/\.babasset$/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, "_");
  return cleaned.length > 0 ? cleaned : "Graph";
}

function paramType(
  value: unknown,
): "string" | "float" | "int" | "bool" | "enum" {
  return typeof value === "string" && PARAM_TYPES.has(value)
    ? (value as "string" | "float" | "int" | "bool" | "enum")
    : "float";
}

export function consoleCommandFromGraph(
  graph: LogicGraph,
  classId: string,
): ScriptConsoleCommand | undefined {
  const node = graph.nodes.find((entry) => entry.typeId === "flow.event.commandRun");
  if (!node) return undefined;
  const properties = node.properties;
  const rawParams = Array.isArray(properties.parameters)
    ? properties.parameters
    : [];
  const name =
    typeof properties.commandName === "string" && properties.commandName.trim()
      ? properties.commandName.trim()
      : classId.toLowerCase();
  return {
    name,
    description:
      typeof properties.description === "string" ? properties.description : "",
    category:
      typeof properties.category === "string" && properties.category.trim()
        ? properties.category.trim()
        : "game",
    parameters: rawParams.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const param = row as {
        name?: unknown;
        type?: unknown;
        optional?: unknown;
        defaultValue?: unknown;
        enumValues?: unknown;
      };
      if (typeof param.name !== "string" || !param.name.trim()) return [];
      return [
        {
          name: param.name.trim(),
          type: paramType(param.type),
          ...(param.optional === true ? { optional: true } : {}),
          ...(param.defaultValue !== undefined
            ? { defaultValue: param.defaultValue }
            : {}),
          ...(Array.isArray(param.enumValues)
            ? {
                enumValues: param.enumValues.filter(
                  (value): value is string => typeof value === "string",
                ),
              }
            : {}),
        },
      ];
    }),
  };
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
  const classId = classIdForGraphPath(options.path);
  return {
    assetGuid: options.path,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    command: consoleCommandFromGraph(logic, classId),
  };
}

/** Scripts whose entry points bind to a lifecycle event get a live actor. */
export function spawnListForScripts(
  scripts: readonly ScriptBundleEntry[],
): Array<{ classId: string }> {
  const seen = new Set<string>();
  const spawn: Array<{ classId: string }> = [];
  for (const script of scripts) {
    if (
      !script.entryPoints.some(
        (entry) => entry.event && ACTOR_LIFECYCLE_EVENTS.has(entry.event),
      )
    ) {
      continue;
    }
    if (seen.has(script.classId)) continue;
    seen.add(script.classId);
    spawn.push({ classId: script.classId });
  }
  return spawn;
}

export type GraphCompileDocument = {
  path: string;
  content: SerializedGraph;
};

/**
 * Stable fingerprint of graph *compile* inputs. Node positions are omitted so
 * Format / canvas nudges do not re-enable Compile.
 */
export function graphCompileSignature(
  documents: ReadonlyArray<GraphCompileDocument>,
): string {
  const payload = [...documents]
    .map((doc) => ({
      path: doc.path,
      nodes: doc.content.nodes
        .map((node) => ({
          id: node.id,
          type: node.type,
          data: node.data,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...doc.content.edges].sort((a, b) => a.id.localeCompare(b.id)),
      members: doc.content.members ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(payload);
}

export function graphsNeedCompile(
  currentSignature: string,
  lastCompiledSignature: string | null,
): boolean {
  return lastCompiledSignature !== currentSignature;
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
