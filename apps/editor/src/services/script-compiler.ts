import {
  isUserInterfaceClassId,
  type GraphClassMember,
  type SerializedGraph,
} from "@babylonslate/core";
import type {
  ScriptBundleEntry,
  ScriptConsoleCommand,
} from "@babylonslate/bridge";
import {
  animGraphScriptClassId,
  animRuleScriptClassId,
  decorateTransitionRuleGraph,
  findReverseTransition,
  parseAnimGraphDocument,
  type AnimGraphDocument,
} from "@babylonslate/anim-graph";
import {
  compileGraph,
  compileTransitionRuleGraph,
  type LogicGraph,
  isLogicGraphPayload,
} from "@babylonslate/scripting";
import { localVariablePreamble } from "@babylonslate/scripting-nodes";
import { defaultNodeRegistry, materializeLogicGraph, type HydrateGraphOptions } from "./graph-validation";

const ACTOR_LIFECYCLE_EVENTS = new Set(["onBeginPlay", "onTick"]);
const PARAM_TYPES = new Set(["string", "float", "int", "bool", "enum"]);

/**
 * Class a graph's compiled script binds to. Class (and legacy Graph) files
 * use the file stem as the stable key.
 */
export function classIdForGraphPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const base = file
    .replace(/\.(graph|class|ui|eui)\.(babasset|json)$/, "")
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

function jsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function compileGraphDocument(
  content: SerializedGraph | LogicGraph,
  options: {
    path: string;
    graphId?: string;
    classId?: string;
    parentClassId?: string | null;
    stripDevelopmentOnly?: boolean;
    instrumentInfiniteLoops?: boolean;
    enums?: HydrateGraphOptions["enums"];
    structs?: HydrateGraphOptions["structs"];
  },
): ScriptBundleEntry | null {
  const graphId = options.graphId ?? "event-graph";
  const serialized = isLogicGraphPayload(content) ? null : content;
  const typeOptions: HydrateGraphOptions = {
    enums: options.enums,
    structs: options.structs,
  };
  const logic = materializeLogicGraph(content, graphId, "event", typeOptions);
  const instrumentInfiniteLoops =
    options.instrumentInfiniteLoops ?? options.stripDevelopmentOnly !== true;
  const compiledPieces = [];
  if (logic.nodes.length > 0) {
    compiledPieces.push(
      compileGraph(logic, {
        assetGuid: options.path,
        registry: defaultNodeRegistry,
        stripDevelopmentOnly: options.stripDevelopmentOnly,
        instrumentInfiniteLoops,
      }),
    );
  }
  if (serialized?.functionGraphs) {
    for (const [memberId, slice] of Object.entries(serialized.functionGraphs)) {
      const member = serialized.members?.find((entry) => entry.id === memberId);
      const exportName = jsIdent(member?.name ?? memberId);
      const fnLogic = materializeLogicGraph(
        { nodes: slice.nodes, edges: slice.edges },
        exportName,
        "function",
        typeOptions,
      );
      if (fnLogic.nodes.length === 0) continue;
      const locals = (serialized.members ?? []).filter(
        (entry) => entry.kind === "variable" && entry.functionId === memberId,
      );
      compiledPieces.push(
        compileGraph(fnLogic, {
          assetGuid: options.path,
          registry: defaultNodeRegistry,
          exportName,
          stripDevelopmentOnly: options.stripDevelopmentOnly,
          instrumentInfiniteLoops,
          localPreamble: localVariablePreamble(locals),
        }),
      );
    }
  }
  if (compiledPieces.length === 0) return null;
  let source = compiledPieces[0]!.source;
  const anchors = [...compiledPieces[0]!.anchors];
  const entryPoints = [...compiledPieces[0]!.entryPoints];
  for (const extra of compiledPieces.slice(1)) {
    const extraBody = extra.source
      .split("\n")
      .filter((line) => !line.startsWith("//# sourceURL"))
      .join("\n");
    const offset = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    source = `${source.replace(/\n$/, "")}\n${extraBody}`;
    for (const anchor of extra.anchors) {
      anchors.push({ ...anchor, line: anchor.line + offset });
    }
    entryPoints.push(...extra.entryPoints);
  }
  const classId = options.classId?.trim() || classIdForGraphPath(options.path);
  const metadata = classMetadataFromGraph(content, options.parentClassId);
  return {
    assetGuid: options.path,
    classId,
    source,
    anchors,
    entryPoints,
    command: consoleCommandFromGraph(logic, classId),
    ...metadata,
  };
}

function classMetadataFromGraph(
  content: SerializedGraph | LogicGraph,
  parentClassId?: string | null,
): Pick<
  ScriptBundleEntry,
  | "parentClassId"
  | "implementedInterfaces"
  | "variables"
  | "interfaceImplementations"
> {
  const members: GraphClassMember[] = isLogicGraphPayload(content)
    ? []
    : (content.members ?? []);
  const implementedInterfaces = members.flatMap((member) =>
    member.kind === "interface" && member.assetGuid
      ? [member.assetGuid]
      : [],
  );
  const interfaceImplementations = members.flatMap((member) => {
    if (member.kind !== "function" || !member.implementsInterface) return [];
    return [
      {
        interfaceGuid: member.implementsInterface.assetGuid,
        method: member.implementsInterface.methodName,
        exportName: jsIdent(member.name),
      },
    ];
  });
  const variables = members.flatMap((member) => {
    if (member.kind !== "variable" || member.functionId) return [];
    return [
      {
        name: member.name,
        type: member.typeId ?? "float",
        ...(member.container === "array" || member.container === "map"
          ? { container: member.container }
          : {}),
        ...(member.container === "map"
          ? { keyTypeId: member.keyTypeId ?? "string" }
          : {}),
        ...(member.keyTypeClassId && member.container === "map"
          ? { keyTypeClassId: member.keyTypeClassId }
          : {}),
        ...(member.defaultValue !== undefined
          ? { defaultValue: member.defaultValue }
          : {}),
      },
    ];
  });
  const parent = parentClassId?.trim();
  return {
    ...(parent ? { parentClassId: parent } : {}),
    ...(implementedInterfaces.length > 0 ? { implementedInterfaces } : {}),
    ...(interfaceImplementations.length > 0
      ? { interfaceImplementations }
      : {}),
    ...(variables.length > 0 ? { variables } : {}),
  };
}

/** Scripts whose entry points bind to a lifecycle event get a live actor. */
export function spawnListForScripts(
  scripts: readonly ScriptBundleEntry[],
): Array<{ classId: string }> {
  const seen = new Set<string>();
  const spawn: Array<{ classId: string }> = [];
  for (const script of scripts) {
    if (isUserInterfaceClassId(script.classId)) continue;
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
      functionGraphs: doc.content.functionGraphs ?? {},
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
    classId?: string;
    parentClassId?: string | null;
  }>,
  options: {
    stripDevelopmentOnly?: boolean;
    enums?: HydrateGraphOptions["enums"];
    structs?: HydrateGraphOptions["structs"];
  } = {},
): ScriptBundleEntry[] {
  const scripts: ScriptBundleEntry[] = [];
  for (const doc of documents) {
    try {
      const script = compileGraphDocument(doc.content, {
        path: doc.path,
        classId: doc.classId,
        parentClassId: doc.parentClassId,
        stripDevelopmentOnly: options.stripDevelopmentOnly,
        enums: options.enums,
        structs: options.structs,
      });
      if (script) scripts.push(script);
    } catch (error) {
      // A graph that fails codegen must not stop Preview; the validator has
      // already surfaced the error in Compiler Results.
      console.error(`[play] failed to compile ${doc.path}`, error);
    }
  }
  return scripts;
}

/** Release / packed export compile — always omits Development Only nodes. */
export function compileGraphDocumentsForExport(
  documents: ReadonlyArray<{
    path: string;
    content: SerializedGraph | LogicGraph;
    classId?: string;
    parentClassId?: string | null;
  }>,
): ScriptBundleEntry[] {
  return compileGraphDocuments(documents, { stripDevelopmentOnly: true });
}

export type AnimGraphCompileDocument = {
  guid: string;
  path: string;
  document: AnimGraphDocument | unknown;
};

/**
 * Compile Animation Object lifecycle graphs and each transition-rule evaluate().
 * Class ids are `AnimGraph:{guid}` / `AnimRule:{guid}:{transitionId}` so Play
 * does not spawn extra actors.
 */
export function compileAnimGraphScripts(
  documents: ReadonlyArray<AnimGraphCompileDocument>,
  options: { stripDevelopmentOnly?: boolean } = {},
): ScriptBundleEntry[] {
  const scripts: ScriptBundleEntry[] = [];
  for (const entry of documents) {
    try {
      const doc = parseAnimGraphDocument(entry.document);
      if (!doc) continue;
      const objectScript = compileGraphDocument(doc.animationObject, {
        path: entry.path,
        graphId: "animation-object",
        parentClassId: "BObject",
        stripDevelopmentOnly: options.stripDevelopmentOnly,
      });
      if (objectScript) {
        scripts.push({
          ...objectScript,
          classId: animGraphScriptClassId(entry.guid),
          parentClassId: "BObject",
        });
      }
      for (const transition of doc.transitions) {
        const oneWay = !findReverseTransition(
          doc.transitions,
          transition.fromStateId,
          transition.toStateId,
        );
        const ruleGraph = decorateTransitionRuleGraph(
          transition.ruleGraph ?? {
            nodes: [],
            edges: [],
          },
          oneWay,
        );
        const logic = materializeLogicGraph(
          ruleGraph,
          `rule-${transition.id}`,
        );
        const compiled = compileTransitionRuleGraph(logic, {
          assetGuid: entry.path,
          registry: defaultNodeRegistry,
          stripDevelopmentOnly: options.stripDevelopmentOnly,
        });
        scripts.push({
          assetGuid: entry.path,
          classId: animRuleScriptClassId(entry.guid, transition.id),
          source: compiled.source,
          anchors: compiled.anchors,
          entryPoints: compiled.entryPoints.map((point) => ({
            name: point.name,
            isAsync: point.isAsync,
            ...(point.event ? { event: point.event } : {}),
          })),
          parentClassId: "BObject",
        });
      }
    } catch (error) {
      console.error(`[play] failed to compile AnimationGraph ${entry.path}`, error);
    }
  }
  return scripts;
}
