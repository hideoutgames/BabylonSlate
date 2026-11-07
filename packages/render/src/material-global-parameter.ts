import type { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { GlobalParameterSelection } from "@haptic/core";
import { createConstantBlock } from "./material-block-registry";
import { globalParameterComponents, type GlobalParameterValueSource } from "./global-parameter-values";

const BLOCK_TYPES = { float: "float", vec2: "vec2", vec3: "vec3", color: "vec4" } as const;

/**
 * The uniform of a Material **Global Parameter** node. It reads `source` when the Material
 * binds and refreshes only after the source's revision moves, so setting a global parameter
 * changes every Material that reads it without a recompile. A Color is converted to linear
 * space like a Color Parameter.
 */
export function createGlobalParameterBlock(
  name: string,
  selection: GlobalParameterSelection,
  source: GlobalParameterValueSource,
): InputBlock {
  const { collectionGuid, parameterId, valueType } = selection;
  const read = () => globalParameterComponents(source, collectionGuid, parameterId, valueType);
  const initial = read();
  const block = createConstantBlock(name, BLOCK_TYPES[valueType], initial, valueType === "color");
  let revision = source.revision;
  let scalar = initial[0] ?? 0;
  // Babylon transmits a Color uniform from `block.value` even with a callback, so vectors and
  // colors are refreshed in place and the callback returns the same object.
  block.valueCallback = () => {
    if (source.revision !== revision) {
      revision = source.revision;
      const [x = 0, y = 0, z = 0, w = 1] = read();
      const stored: unknown = block.value;
      if (stored instanceof Color4) stored.set(x, y, z, w);
      else if (stored instanceof Vector3) stored.set(x, y, z);
      else if (stored instanceof Vector2) stored.set(x, y);
      else scalar = x;
    }
    return valueType === "float" ? scalar : block.value;
  };
  return block;
}
