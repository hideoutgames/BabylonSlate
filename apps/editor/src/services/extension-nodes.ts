import type { ExtensionDescriptor, ExtensionNodeContribution, ExtensionNodePinType } from "@haptic/assets";
import {
  BOOL, COLOR, EXEC, FLOAT, INT, QUAT, ROTATOR, STRING, TRANSFORM, VEC2, VEC3, VEC4,
  extensionNodeTypeId, pin, type NodeDefinition, type NodeRegistry, type PinType,
} from "@haptic/scripting";

const PIN_TYPES: Readonly<Record<ExtensionNodePinType, PinType>> = {
  bool: BOOL, int: INT, float: FLOAT, string: STRING, vec2: VEC2, vec3: VEC3, vec4: VEC4,
  rotator: ROTATOR, quat: QUAT, transform: TRANSFORM, color: COLOR,
};

/**
 * Module-scope helper every extension node calls through: a missing library
 * (failed to load, or disabled since the compile) or export fails with a clear
 * error instead of a TypeError. `extensions` is the compiled module's shim parameter.
 */
const CALL_HELPER = `function __extensionCall(library, name) {
  const fn = extensions[library]?.[name];
  if (typeof fn !== "function") throw new Error(\`Extension library \${library} has no function \${name}.\`);
  return fn;
}`;

function nodeDefinition(extension: ExtensionDescriptor, node: ExtensionNodeContribution): NodeDefinition {
  const callee = `__extensionCall(${JSON.stringify(extension.settings.libraryName)}, ${JSON.stringify(node.call)})`;
  const callWith = (ctx: Parameters<NodeDefinition["codegen"]>[0]) =>
    `${callee}(${node.inputs.map((input) => ctx.input(input.id)).join(", ")})`;
  const dataPins = [
    ...node.inputs.map((input) => pin(input.id, input.name, "in", PIN_TYPES[input.type], "data", true, input.default)),
    ...node.outputs.map((output) => pin(output.id, output.name, "out", PIN_TYPES[output.type])),
  ];
  return {
    id: extensionNodeTypeId(extension.extensionGuid, node.id),
    title: node.title,
    category: node.category ?? extension.settings.displayName,
    ...(node.description ? { description: node.description } : {}),
    ...(node.hosts.length ? { hosts: node.hosts } : {}),
    ...(node.pure ? { pure: true } : {}),
    ...(node.latent ? { latent: true } : {}),
    pins: () => node.pure ? dataPins : [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), ...dataPins],
    codegen: (ctx) => {
      ctx.hoist(CALL_HELPER);
      const call = callWith(ctx);
      if (node.pure) {
        if (node.outputs.length === 1) return { [node.outputs[0]!.id]: call };
        const result = ctx.shared?.(call) ?? call;
        return Object.fromEntries(node.outputs.map((output) => [output.id, `(${result})?.[${JSON.stringify(output.id)}]`]));
      }
      const value = node.latent ? `await ${call}` : call;
      if (node.outputs.length === 0) {
        ctx.emit(`${value};`);
      } else if (node.outputs.length === 1) {
        ctx.emit(`${ctx.output(node.outputs[0]!.id)} = ${value};`);
      } else {
        // Several outputs read the keys of the object the export returns.
        const bindings = node.outputs.map((output) => `${JSON.stringify(output.id)}: ${ctx.output(output.id)}`).join(", ");
        ctx.emit(`({ ${bindings} } = (${value}) ?? {});`);
      }
    },
  };
}

/** The Class graph nodes a gameplay extension declares in `contributes.nodes`. */
export function extensionNodeDefinitions(extension: ExtensionDescriptor): NodeDefinition[] {
  if (extension.invalid || extension.settings.editorOnly) return [];
  return (extension.settings.contributes.nodes ?? []).map((node) => nodeDefinition(extension, node));
}

const registeredIds = new WeakMap<NodeRegistry, string[]>();
let fingerprint = "[]";

/**
 * Replaces the extension nodes in `registry` with those of `extensions`
 * (enabled gameplay packages). A graph keeps nodes whose extension went away;
 * validation reports them until the extension returns or the node is removed.
 */
export function syncExtensionNodes(registry: NodeRegistry, extensions: readonly ExtensionDescriptor[]): void {
  for (const id of registeredIds.get(registry) ?? []) registry.unregister(id);
  const definitions = extensions.flatMap(extensionNodeDefinitions);
  for (const definition of definitions) registry.register(definition);
  registeredIds.set(registry, definitions.map((definition) => definition.id));
  fingerprint = JSON.stringify(extensions.filter((extension) => extensionNodeDefinitions(extension).length > 0).map((extension) => [
    extension.extensionGuid, extension.settings.libraryName, extension.settings.displayName, extension.settings.contributes.nodes,
  ]));
}

/** Identity of the registered extension nodes, for compile and Add Node caches. */
export function extensionNodesFingerprint(): string {
  return fingerprint;
}
