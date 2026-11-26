import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import { isPureNode, type NodeRegistry } from "./node-registry";

/** Identifiers that live inside an entry function and prevent hoisting a helper to module scope. */
const ENTRY_LOCAL_IDENT = /(?<![\w$])(_n_|__lv_|__s\d+|__u\d+|__memo_|_pure_|__dbg|__bp|__ref_|__arg_)/;

/** Bound expression expansion without eagerly evaluating branches or service reads. */
export function createPureExpressions(
  graph: LogicGraph,
  registry: NodeRegistry,
  hoistHelper?: (namePrefix: string, source: string) => string,
) {
  const declarations: string[] = [];
  const transparent = new Map<string, boolean>();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(graph.edges.map((edge) => [`${edge.targetNodeId}:${edge.targetPinId}`, edge]));
  function isTransparent(node: GraphNode): boolean {
    if (transparent.has(node.id)) return transparent.get(node.id)!;
    transparent.set(node.id, false);
    const definition = registry.get(node.typeId);
    const result = isPureNode(definition, node) && definition?.referentiallyTransparent === true &&
      node.pins.filter((pin) => pin.direction === "in" && pin.kind === "data").every((pin) => {
        const edge = incoming.get(`${node.id}:${pin.id}`);
        if (!edge) return true;
        const source = nodes.get(edge.sourceNodeId);
        return source !== undefined && isTransparent(source);
      });
    transparent.set(node.id, result);
    return result;
  }
  /** A value no later read can see change: an immutable kind computed from constants alone. */
  function isConstant(node: GraphNode, pin: GraphPin): boolean {
    const immutable = ["bool", "int", "tag", "float", "string", "enumRef", "classRef", "assetRef"].includes(pin.type.kind);
    return immutable && isTransparent(node);
  }
  return {
    declarations,
    isConstant,
    expression(node: GraphNode, pin: GraphPin, expression: string): string {
      if (expression.length <= 512) return `(${expression})`;
      const constant = isConstant(node, pin);
      if (hoistHelper && !ENTRY_LOCAL_IDENT.test(expression)) {
        const source = constant
          ? `var __NAME___r = false, __NAME___v; var __NAME__ = (ctx) => (__NAME___r ? __NAME___v : (__NAME___v = (${expression}), __NAME___r = true, __NAME___v));`
          : `var __NAME__ = (ctx) => (${expression});`;
        return `${hoistHelper("__pure", source)}(ctx)`;
      }
      const name = `_pure_${declarations.length}`;
      // Mutable values preserve the identity/allocation semantics of each read.
      if (constant) {
        declarations.push(`  let ${name}_ready = false, ${name}_value;\n  const ${name} = () => { if (!${name}_ready) { ${name}_value = (${expression}); ${name}_ready = true; } return ${name}_value; };`);
      } else {
        declarations.push(`  const ${name} = () => (${expression});`);
      }
      return `${name}()`;
    },
  };
}
