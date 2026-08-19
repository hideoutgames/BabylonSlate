import type { PinType } from "./types";
import type { GraphNode, GraphPin, LogicGraph } from "./ir";
import { registerDevelopmentOnlyByDefaultTypeId } from "./development-only";
import type { StructuredFlowMeta } from "./structured-flow";

/** 1-based line in a hoist chunk mapped to an ExecuteJavaScript body line. */
export type HoistBodyAnchor = {
  relativeLine: number;
  bodyLine: number;
};

export type CodegenContext = {
  graph: LogicGraph;
  node: GraphNode;
  /** Resolved expression text for an input data pin (or default). */
  input(pinName: string): string;
  /** Temp var name for an output data pin. */
  output(pinName: string): string;
  /** Emit a statement with an optional anchor override. */
  emit(statement: string, anchorNodeId?: string): void;
  /**
   * Hoist a module-scope function (ExecuteJavaScript).
   * `bodyAnchors` are 1-based lines within this chunk that map to the user body.
   */
  hoist(
    source: string,
    bodyAnchors?: readonly HoistBodyAnchor[],
  ): void;
  /**
   * Mark the entry point `async`. Required before emitting `await`; latent
   * definitions are marked automatically.
   */
  requestAsync(): void;
  indent: string;
};

export type NodeDefinition = {
  id: string;
  title: string;
  category: string;
  pins: (properties: Record<string, unknown>) => GraphPin[];
  /** Pure expression nodes return a map of output pin name → expression. */
  codegen: (ctx: CodegenContext) => void | Record<string, string>;
  pure?: boolean;
  latent?: boolean;
  /** Hidden from runtime graph palettes unless the host is an editor graph. */
  editorOnly?: boolean;
  /**
   * When the Inspector flag is omitted, export compiles strip this node.
   * Print, Print String, and Draw Debug opt in so shipping games stay clean
   * unless the author unchecks Development Only.
   */
  developmentOnlyByDefault?: boolean;
  /**
   * Structured control-flow discriminator. Preferred over scattered typeId
   * checks for new flow nodes (Switch on Int / String; later loops / Gate).
   */
  structuredFlow?: StructuredFlowMeta;
};

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition): void {
    if (this.defs.has(def.id)) {
      throw new Error(`Node already registered: ${def.id}`);
    }
    this.defs.set(def.id, def);
    if (def.developmentOnlyByDefault) {
      registerDevelopmentOnlyByDefaultTypeId(def.id);
    }
  }

  registerAll(defs: readonly NodeDefinition[]): void {
    for (const def of defs) this.register(def);
  }

  get(id: string): NodeDefinition | undefined {
    return this.defs.get(id);
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()];
  }

  listByCategory(category: string): NodeDefinition[] {
    return this.list().filter((d) => d.category === category);
  }
}

export function pin(
  id: string,
  name: string,
  direction: "in" | "out",
  type: PinType,
  kind: "exec" | "data" = type.kind === "exec" ? "exec" : "data",
  optional = false,
  defaultValue?: unknown,
): GraphPin {
  return {
    id,
    name,
    direction,
    type,
    kind,
    optional,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}
