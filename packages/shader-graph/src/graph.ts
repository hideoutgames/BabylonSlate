export type ShaderValueKind = "float" | "vec2" | "vec3" | "vec4" | "color" | "texture";

export type ShaderNodeKind =
  | "input.uv"
  | "input.time"
  | "texture.sample"
  | "math.multiply"
  | "math.add"
  | "output.fragment"
  | "output.postProcess"
  | "custom";

export interface ShaderGraphNode {
  id: string;
  type: ShaderNodeKind;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

export interface ShaderGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

export interface ShaderGraphDocument {
  name: string;
  nodes: ShaderGraphNode[];
  edges: ShaderGraphEdge[];
  /** Post-process graphs are off by default and flagged as iPad-costly. */
  postProcess: boolean;
}

export interface ShaderDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  severity: "error" | "warning";
}

/** Headless compile result; render turns this into a NodeMaterial. */
export interface ShaderCompileResult {
  fragmentOutputNodeId: string | null;
  postProcess: boolean;
  ipadCostWarning: boolean;
  sampledTextures: string[];
  customBlocks: string[];
}

export const SHADER_CATALOG: ReadonlyArray<{
  type: ShaderNodeKind;
  title: string;
  category: string;
}> = [
  { type: "input.uv", title: "UV", category: "Input" },
  { type: "input.time", title: "Time", category: "Input" },
  { type: "texture.sample", title: "Texture Sample", category: "Texture" },
  { type: "math.multiply", title: "Multiply", category: "Math" },
  { type: "math.add", title: "Add", category: "Math" },
  { type: "output.fragment", title: "Fragment Output", category: "Output" },
  { type: "output.postProcess", title: "Post Process Output", category: "Output" },
  { type: "custom", title: "Custom Block", category: "Custom" },
];

export function createDefaultShaderGraph(name = "Surface"): ShaderGraphDocument {
  return {
    name,
    postProcess: false,
    nodes: [
      {
        id: "uv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "out",
        type: "output.fragment",
        position: { x: 280, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e0",
        sourceNodeId: "uv",
        sourcePinId: "uv",
        targetNodeId: "out",
        targetPinId: "color",
      },
    ],
  };
}

export function validateShaderGraph(doc: ShaderGraphDocument): ShaderDiagnostic[] {
  const diagnostics: ShaderDiagnostic[] = [];
  const ids = new Set(doc.nodes.map((node) => node.id));
  const outputs = doc.nodes.filter(
    (node) => node.type === "output.fragment" || node.type === "output.postProcess",
  );
  if (outputs.length === 0) {
    diagnostics.push({
      code: "shader.noOutput",
      message: "Shader graph needs a fragment or post-process output",
      severity: "error",
    });
  }
  if (doc.postProcess) {
    diagnostics.push({
      code: "shader.ipadCost",
      message: "Post-process materials are expensive on iPad and off by default",
      severity: "warning",
    });
  }
  for (const edge of doc.edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId)) {
      diagnostics.push({
        code: "shader.danglingEdge",
        message: `Edge "${edge.id}" points at a missing node`,
        nodeId: edge.id,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

export function compileShaderGraph(doc: ShaderGraphDocument): ShaderCompileResult {
  const fragment = doc.nodes.find((node) => node.type === "output.fragment");
  const post = doc.nodes.find((node) => node.type === "output.postProcess");
  const sampledTextures = doc.nodes
    .filter((node) => node.type === "texture.sample")
    .map((node) =>
      typeof node.properties.textureGuid === "string"
        ? node.properties.textureGuid
        : node.id,
    );
  const customBlocks = doc.nodes
    .filter((node) => node.type === "custom")
    .map((node) =>
      typeof node.properties.code === "string" ? node.properties.code : node.id,
    );
  return {
    fragmentOutputNodeId: fragment?.id ?? post?.id ?? null,
    postProcess: doc.postProcess || Boolean(post),
    ipadCostWarning: doc.postProcess || Boolean(post),
    sampledTextures,
    customBlocks,
  };
}

export const PREVIEW_THROTTLE_MS = 250;

export function shouldRecompilePreview(
  lastCompileAt: number,
  now: number,
  throttleMs = PREVIEW_THROTTLE_MS,
): boolean {
  return now - lastCompileAt >= throttleMs;
}
