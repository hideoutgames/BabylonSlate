import {
  pin,
  type NodeDefinition,
  EXEC,
  BOOL,
} from "@babylonslate/scripting";

export const flowNodes: NodeDefinition[] = [
  {
    id: "flow.entry",
    title: "Entry",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry is a no-op marker */
    },
  },
  {
    id: "flow.branch",
    title: "Branch",
    category: "flow",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("condition", "condition", "in", BOOL),
      pin("true", "true", "out", EXEC),
      pin("false", "false", "out", EXEC),
    ],
    codegen: () => {
      /* handled specially by compiler */
    },
  },
  {
    id: "flow.sequence",
    title: "Sequence",
    category: "flow",
    pins: (properties) => {
      const count = Math.max(1, Number(properties.count ?? 2));
      const pins = [pin("execIn", "exec", "in", EXEC)];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`then${i}`, `then_${i}`, "out", EXEC));
      }
      return pins;
    },
    codegen: () => {
      /* handled specially by compiler */
    },
  },
];
