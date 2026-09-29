import { pin, type NodeDefinition, objectRef } from "@babylonslate/scripting";

/**
 * Generic Get <Subsystem> node. Hidden from Add Node like Cast: the editor
 * injects one row per project subsystem class with `subsystemGetProperties`.
 */
export const SUBSYSTEM_GET_NODE_ID = "subsystem.get";

/** Engine bases a user subsystem class derives from. */
export type SubsystemBaseClassId = "GameSubsystem" | "SceneSubsystem";

/** Pin type used when a node has no `classId` (always a validation error). */
const FALLBACK_SUBSYSTEM_CLASS_ID = "Subsystem";

/** Requested subsystem class id, trimmed; `""` when the node has none. */
export function subsystemGetClassId(properties: Record<string, unknown>): string {
  const raw = properties.classId;
  return typeof raw === "string" ? raw.trim() : "";
}

/** Node properties for a Get <classId> row. */
export function subsystemGetProperties(classId: string): { classId: string } {
  return { classId: classId.trim() };
}

/** Palette and node title: raw class id, like Cast (`Get InventorySubsystem`). */
export function subsystemGetTitle(classId: string): string {
  const trimmed = classId.trim();
  return trimmed ? `Get ${trimmed}` : "Get Subsystem";
}

/**
 * Add Node category for a subsystem class's Get row, by engine base lineage.
 * Lower-kebab like every catalog category; the palette shows `Game Subsystems`
 * / `Scene Subsystems`.
 */
export function subsystemGetPaletteCategory(base: SubsystemBaseClassId): string {
  return base === "GameSubsystem" ? "game-subsystems" : "scene-subsystems";
}

export const subsystemNodes: NodeDefinition[] = [
  {
    id: SUBSYSTEM_GET_NODE_ID,
    title: subsystemGetTitle(""),
    category: "subsystem",
    description:
      "Returns the live subsystem of this class, or null when none is alive.",
    pure: true,
    pins: (properties) => [
      pin(
        "subsystem",
        "Subsystem",
        "out",
        objectRef(subsystemGetClassId(properties) || FALLBACK_SUBSYSTEM_CLASS_ID),
      ),
    ],
    codegen: (ctx) => {
      const classId = subsystemGetClassId(ctx.node.properties);
      return {
        subsystem: classId
          ? `ctx.getSubsystem(${JSON.stringify(classId)})`
          : "null",
      };
    },
  },
];
