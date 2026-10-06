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
  /** Resolve a writable variable input without evaluating its current value. */
  reference?(pinName: string): string;
  /** Run this node's outgoing execution chain only when this expression is true. */
  continueIf?(expression: string): void;
  /** Choose exactly one outgoing execution pin after this node completes. */
  branch?(expression: string, truePin: string, falsePin: string): void;
  /**
   * Static type of the source pin wired into an input data pin (resolved in
   * compileGraph; declared in transition-rule graphs). Undefined when the
   * input is disconnected or its source is stripped from this build.
   */
  inputType?(pinName: string): PinType | undefined;
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
  /**
   * True when Call Function should `await` the target (Delay or other latent
   * work inside that Function).
   */
  isLatentFunction?(classId: string, functionName: string): boolean;
  indent: string;
};

export type NodeDefinition = {
  id: string;
  title: string;
  category: string;
  /** Author-facing contract shown in the node catalog. */
  description?: string;
  /** Add Node search metadata; never part of an authored graph. */
  searchAliases?: readonly string[];
  pins: (properties: Record<string, unknown>) => GraphPin[];
  /** Pure expression nodes return a map of output pin name → expression. */
  codegen: (ctx: CodegenContext) => void | Record<string, string>;
  pure?: boolean;
  /** No observable reads/effects beyond inputs. Allows caching immutable outputs
   * only when every dependency is also referentially transparent. */
  referentiallyTransparent?: boolean;
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
   * checks for Switch on Int / String, loops / Break, and stateful flow.
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
