import { builtinClassId } from "./builtins";
import type { BtNodeKind } from "./types";

export type BtCatalogKind = BtNodeKind | "decorator" | "service";

export type BtCatalogEntry = {
  classId: string;
  title: string;
  category: "Composites" | "Tasks" | "Decorators" | "Services";
  kind: BtCatalogKind;
};

export type BtPropertyFieldKind =
  | "number"
  | "text"
  | "enum"
  | "blackboardKey"
  | "boolean"
  | "vector3"
  | "asset";

export type BtPropertyField = {
  id: string;
  label: string;
  kind: BtPropertyFieldKind;
  key: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  assetType?: string;
};

export const BT_COMPARE_OPS: Array<{ value: string; label: string }> = [
  { value: "eq", label: "Equal" },
  { value: "neq", label: "Not Equal" },
  { value: "gt", label: "Greater" },
  { value: "gte", label: "Greater Or Equal" },
  { value: "lt", label: "Less" },
  { value: "lte", label: "Less Or Equal" },
];

const TITLES: Record<string, string> = {
  "bt.composite.selector": "Selector",
  "bt.composite.sequence": "Sequence",
  "bt.composite.parallel": "Parallel",
  "bt.task.succeed": "Succeed",
  "bt.task.fail": "Fail",
  "bt.task.wait": "Wait",
  "bt.task.setBlackboard": "Set Blackboard",
  "bt.task.moveTo": "Move To",
  "bt.task.rotateToFace": "Rotate To Face",
  "bt.task.playAnimation": "Play Animation",
  "bt.task.playSound": "Play Sound",
  "bt.decorator.blackboardIsSet": "Blackboard Is Set",
  "bt.decorator.compareBlackboardValue": "Compare Blackboard Value",
  "bt.decorator.loop": "Loop",
  "bt.decorator.cooldown": "Cooldown",
  "bt.decorator.timeLimit": "Time Limit",
  "bt.service.setBlackboard": "Set Blackboard",
};

function titleCaseSegment(raw: string): string {
  const stripped = raw.replace(
    /^(BTTask_|BTDecorator_|BTService_|BTComposite_)/i,
    "",
  );
  return stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => {
      if (word.toLowerCase() === "ms") return "MS";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function titleForBtClassId(classId: string): string {
  const canonical = builtinClassId(classId);
  if (TITLES[canonical]) return TITLES[canonical]!;
  const last = canonical.includes(".")
    ? canonical.slice(canonical.lastIndexOf(".") + 1)
    : canonical;
  return titleCaseSegment(last);
}

function entry(
  classId: string,
  category: BtCatalogEntry["category"],
  kind: BtCatalogKind,
): BtCatalogEntry {
  return { classId, title: titleForBtClassId(classId), category, kind };
}

export const BT_COMPOSITE_CATALOG: BtCatalogEntry[] = [
  entry("bt.composite.selector", "Composites", "selector"),
  entry("bt.composite.sequence", "Composites", "sequence"),
  entry("bt.composite.parallel", "Composites", "parallel"),
];

export const BT_TASK_CATALOG: BtCatalogEntry[] = [
  entry("bt.task.succeed", "Tasks", "task"),
  entry("bt.task.fail", "Tasks", "task"),
  entry("bt.task.wait", "Tasks", "task"),
  entry("bt.task.setBlackboard", "Tasks", "task"),
  entry("bt.task.moveTo", "Tasks", "task"),
  entry("bt.task.rotateToFace", "Tasks", "task"),
  entry("bt.task.playAnimation", "Tasks", "task"),
  entry("bt.task.playSound", "Tasks", "task"),
];

export const BT_DECORATOR_CATALOG: BtCatalogEntry[] = [
  entry("bt.decorator.blackboardIsSet", "Decorators", "decorator"),
  entry("bt.decorator.compareBlackboardValue", "Decorators", "decorator"),
  entry("bt.decorator.loop", "Decorators", "decorator"),
  entry("bt.decorator.cooldown", "Decorators", "decorator"),
  entry("bt.decorator.timeLimit", "Decorators", "decorator"),
];

export const BT_SERVICE_CATALOG: BtCatalogEntry[] = [
  entry("bt.service.setBlackboard", "Services", "service"),
];

function field(
  id: string,
  label: string,
  kind: BtPropertyFieldKind,
  key: string,
  extra?: Partial<BtPropertyField>,
): BtPropertyField {
  return { id, label, kind, key, ...extra };
}

export function propertyFieldsForClassId(classId: string): BtPropertyField[] {
  switch (builtinClassId(classId)) {
    case "bt.task.wait":
    case "bt.decorator.cooldown":
    case "bt.decorator.timeLimit":
      return [field("durationMs", "Duration MS", "number", "durationMs", { min: 0 })];
    case "bt.task.setBlackboard":
    case "bt.service.setBlackboard":
      return [
        field("key", "Key", "blackboardKey", "key"),
        field("value", "Value", "text", "value"),
      ];
    case "bt.task.moveTo":
      return [
        field("destination", "Destination", "vector3", "destination"),
        field("acceptRadius", "Accept Radius", "number", "acceptRadius", { min: 0 }),
      ];
    case "bt.task.playSound":
      return [
        field("audioAssetGuid", "Audio", "asset", "audioAssetGuid", {
          assetType: "Audio",
        }),
        field("volume", "Volume", "number", "volume", { min: 0, max: 1 }),
      ];
    case "bt.decorator.blackboardIsSet":
      return [field("key", "Key", "blackboardKey", "key")];
    case "bt.decorator.compareBlackboardValue":
      return [
        field("key", "Key", "blackboardKey", "key"),
        field("op", "Op", "enum", "op", { options: BT_COMPARE_OPS }),
        field("value", "Value", "text", "value"),
      ];
    case "bt.decorator.loop":
      return [field("numLoops", "Num Loops", "number", "numLoops", { min: 0 })];
    default:
      return [];
  }
}

export function defaultPropertiesForClassId(classId: string): Record<string, unknown> {
  switch (builtinClassId(classId)) {
    case "bt.task.wait":
      return { durationMs: 1000 };
    case "bt.decorator.cooldown":
    case "bt.decorator.timeLimit":
      return { durationMs: 1000 };
    case "bt.task.setBlackboard":
    case "bt.service.setBlackboard":
      return { key: "", value: true };
    case "bt.task.moveTo":
      return { destination: { x: 0, y: 0, z: 0 }, acceptRadius: 0.5 };
    case "bt.task.playSound":
      return { audioAssetGuid: "", volume: 1 };
    case "bt.decorator.blackboardIsSet":
      return { key: "" };
    case "bt.decorator.compareBlackboardValue":
      return { key: "", op: "eq", value: "" };
    case "bt.decorator.loop":
      return { numLoops: 0 };
    default:
      return {};
  }
}

export function kindForCatalogClassId(
  classId: string,
  parentOf?: (id: string) => string | null | undefined,
): BtNodeKind {
  let current: string | null | undefined = classId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const canonical = builtinClassId(current);
    if (canonical === "bt.composite.selector") return "selector";
    if (canonical === "bt.composite.sequence") return "sequence";
    if (canonical === "bt.composite.parallel") return "parallel";
    if (current === "BTComposite") return "sequence";
    current = parentOf?.(current) ?? null;
  }
  return "task";
}
