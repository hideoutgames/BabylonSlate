import type { PinType } from "./types";
import type { GraphNode, GraphPin, LogicGraph } from "./ir";

export type CodegenContext = {
  graph: LogicGraph;
  node: GraphNode;
  /** Resolved expression text for an input data pin (or default). */
  input(pinName: string): string;
  /** Temp var name for an output data pin. */
  output(pinName: string): string;
  /** Emit a statement with an optional anchor override. */
  emit(statement: string, anchorNodeId?: string): void;
  /** Hoist a module-scope function (ExecuteJavaScript). */
  hoist(source: string): void;
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
};

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition): void {
    if (this.defs.has(def.id)) {
      throw new Error(`Node already registered: ${def.id}`);
    }
    this.defs.set(def.id, def);
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
): GraphPin {
  return { id, name, direction, type, kind, optional };
}
