import {
  BOOL,
  EXEC,
  INT,
  STRING,
  pin,
  type NodeDefinition,
} from "@babylonslate/scripting";

const mappingPins = () => [
  pin("kind", "Mapping Kind", "in", STRING, "data", true, "action"),
  pin("mapping", "Mapping", "in", STRING),
];
const slotPins = () => [
  ...mappingPins(),
  pin("index", "Binding Index", "in", INT, "data", true, 0),
];
const execPins = () => [
  pin("execIn", "Exec", "in", EXEC),
  pin("execOut", "Then", "out", EXEC),
];
const slotArgs = (ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0]) =>
  [ctx.input("kind"), ctx.input("mapping"), ctx.input("index")].join(", ");

/** Player-owned overrides; these nodes never alter authored project defaults. */
export const inputBindingNodes: NodeDefinition[] = [
  {
    id: "input.getBinding",
    title: "Get Input Binding",
    category: "input",
    pure: true,
    pins: () => [
      ...slotPins(),
      pin("device", "Input Device", "out", STRING),
      pin("code", "Code", "out", STRING),
      pin("label", "Label", "out", STRING),
      pin("found", "Found", "out", BOOL),
      ...["shift", "ctrl", "alt", "meta"].map((name) =>
        pin(
          name,
          name === "ctrl" ? "Ctrl" : name[0]!.toUpperCase() + name.slice(1),
          "out",
          BOOL,
          "data",
          true,
        ),
      ),
    ],
    codegen: (ctx) => {
      const read = `ctx.inputBindings?.getBinding(${slotArgs(ctx)})`;
      return {
        device: `(${read}?.device ?? "")`,
        code: `(${read}?.code ?? "")`,
        label: `(${read}?.label ?? "")`,
        found: `(${read} != null)`,
        shift: `(${read}?.shift ?? false)`,
        ctrl: `(${read}?.ctrl ?? false)`,
        alt: `(${read}?.alt ?? false)`,
        meta: `(${read}?.meta ?? false)`,
      };
    },
  },
  {
    id: "input.setBinding",
    title: "Set Input Binding",
    category: "input",
    pins: () => [
      ...execPins(),
      ...slotPins(),
      pin("device", "Input Device", "in", STRING, "data", true, "key"),
      pin("code", "Code", "in", STRING),
      ...["shift", "ctrl", "alt", "meta"].map((name) =>
        pin(
          name,
          name === "ctrl" ? "Ctrl" : name[0]!.toUpperCase() + name.slice(1),
          "in",
          BOOL,
          "data",
          true,
          false,
        ),
      ),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.setBinding(${slotArgs(ctx)}, ${["device", "code", "shift", "ctrl", "alt", "meta"].map((name) => ctx.input(name)).join(", ")}) ?? false;`,
      );
    },
  },
  {
    id: "input.beginRebind",
    title: "Begin Input Rebind",
    category: "input",
    pins: () => [
      ...execPins(),
      ...slotPins(),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.beginRebind(${slotArgs(ctx)}) ?? false;`,
      );
    },
  },
  {
    id: "input.getRebindStatus",
    title: "Get Input Rebind Status",
    category: "input",
    pure: true,
    pins: () => [
      pin("status", "Status", "out", STRING),
      pin("listening", "Listening", "out", BOOL),
      pin("completed", "Completed", "out", BOOL),
      pin("cancelled", "Cancelled", "out", BOOL),
    ],
    codegen: () => ({
      status: '(ctx.inputBindings?.getRebindStatus() ?? "idle")',
      listening: '(ctx.inputBindings?.getRebindStatus() === "listening")',
      completed: '(ctx.inputBindings?.getRebindStatus() === "completed")',
      cancelled: '(ctx.inputBindings?.getRebindStatus() === "cancelled")',
    }),
  },
  {
    id: "input.cancelRebind",
    title: "Cancel Input Rebind",
    category: "input",
    pins: execPins,
    codegen: (ctx) => {
      ctx.emit("ctx.inputBindings?.cancelRebind();");
    },
  },
  {
    id: "input.resetBinding",
    title: "Reset Input Mapping",
    category: "input",
    pins: () => [
      ...execPins(),
      ...mappingPins(),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.resetBindings(${ctx.input("kind")}, ${ctx.input("mapping")}) ?? false;`,
      );
    },
  },
  {
    id: "input.resetAllBindings",
    title: "Reset All Input Bindings",
    category: "input",
    pins: execPins,
    codegen: (ctx) => {
      ctx.emit("ctx.inputBindings?.resetBindings();");
    },
  },
  {
    id: "input.exportBindings",
    title: "Export Input Bindings",
    category: "input",
    pure: true,
    pins: () => [pin("data", "Data", "out", STRING)],
    codegen: () => ({ data: '(ctx.inputBindings?.exportBindings() ?? "")' }),
  },
  {
    id: "input.importBindings",
    title: "Import Input Bindings",
    category: "input",
    pins: () => [
      ...execPins(),
      pin("data", "Data", "in", STRING),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.importBindings(${ctx.input("data")}) ?? false;`,
      );
    },
  },
];
