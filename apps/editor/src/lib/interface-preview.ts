import type { InterfaceMethod } from "@babylonslate/scripting";
import type { GraphDocument, SerializedPin } from "@babylonslate/graph-ui";

function pinTypeKind(typeId: string): string {
  if (typeId === "vec2" || typeId === "vec3") return "vector";
  if (typeId === "object") return "object";
  if (typeId === "struct") return "struct";
  if (typeId === "enum") return "enum";
  return typeId;
}

export function interfacePreviewGraph(method: InterfaceMethod): GraphDocument {
  const dataPins: SerializedPin[] = method.pins.map((pin, index) => ({
    id: `data-${index}`,
    name: pin.name,
    kind: "data",
    direction: pin.direction,
    type: { kind: pinTypeKind(pin.typeId) },
  }));
  return {
    nodes: [
      {
        id: "preview",
        type: "function",
        position: { x: 160, y: 80 },
        data: {
          title: method.name,
          __nodeType: "function",
          __pins: [
            {
              id: "execIn",
              name: "exec",
              kind: "exec",
              direction: "in",
              type: { kind: "exec" },
            },
            {
              id: "execOut",
              name: "then",
              kind: "exec",
              direction: "out",
              type: { kind: "exec" },
            },
            ...dataPins,
          ] satisfies SerializedPin[],
        },
      },
    ],
    edges: [],
  };
}
