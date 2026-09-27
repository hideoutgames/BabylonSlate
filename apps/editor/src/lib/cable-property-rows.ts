import { DEFAULT_CABLE_PROPERTIES, parseCableProperties, type SerializedComponent } from "@babylonslate/core";
import { humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import type { ComponentPropertyContext } from "./component-property-rows";

/** Cable authoring shares the standard Scene and Class property controls. */
export function cablePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const properties = parseCableProperties(component.properties);
  const defaults = DEFAULT_CABLE_PROPERTIES;
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const number = (
    key: "cableLength" | "numSegments" | "cableWidth" | "numSides" | "tileMaterial" | "solverIterations" | "gravityScale" | "damping" | "substepTime" | "maxSubsteps" | "collisionFriction" | "sleepThreshold" | "sleepDelay",
    label: string, min: number, max: number | undefined, description?: string, integer = false,
  ): PropertyRow => ({
    kind: "number", id: id(key), label, value: properties[key], defaultValue: defaults[key],
    min, max, sensitivity: integer ? 1 : 0.01,
    precision: key === "substepTime" || key === "sleepThreshold" || key === "cableWidth" ? 4 : undefined,
    description,
    onChange: (value) => update(key, Math.max(min, Math.min(max ?? Infinity, integer ? Math.round(value) : value))),
  });
  const boolean = (key: "enabled" | "attachStart" | "attachEnd" | "enableStiffness" | "enableCollision", label: string, description: string): PropertyRow => ({
    kind: "boolean", id: id(key), label, value: properties[key], defaultValue: defaults[key], description,
    onChange: (value) => update(key, value),
  });
  const targetComponents = (context.actorComponents?.(properties.targetActorId ?? actorId) ?? [])
    .filter((entry) => entry.id !== component.id || properties.targetActorId && properties.targetActorId !== actorId);
  const targetComponentOptions = targetComponents.map((entry) => ({
    value: entry.id,
    label: `${humanizePropertyLabel(entry.classId.replace(/Component$/, ""))} (${entry.id})`,
  }));
  if (properties.targetComponentId && !targetComponents.some((entry) => entry.id === properties.targetComponentId || entry.sourceId === properties.targetComponentId)) {
    targetComponentOptions.push({ value: properties.targetComponentId, label: "Missing Component" });
  }
  const selectedComponent = targetComponents.find((entry) => entry.sourceId === properties.targetComponentId)?.id ?? properties.targetComponentId;
  return [
    boolean("enabled", "Enabled", "Simulate and display this cable during Play."),
    number("cableLength", "Cable Length", 0.01, 10000, "Rest length in world units. A length longer than the endpoint separation lets the cable sag."),
    number("numSegments", "Segments", 1, 64, "Simulation segments. More segments increase both solver and rendering work.", true),
    number("cableWidth", "Cable Width", 0.001, 10, "Rendered cable diameter in world units."),
    number("numSides", "Sides", 3, 12, "Sides around the cable's tube. Fewer sides reduce vertex updates.", true),
    number("tileMaterial", "Tile Material", 0.01, 1000, "Number of texture repeats along the cable."),
    boolean("attachStart", "Attach Start", "Pin the start to this component. Disable to release the start during simulation."),
    boolean("attachEnd", "Attach End", "Pin the end to End Position in the target frame. Disable to release the end during simulation."),
    {
      kind: "asset", id: id("targetActorId"), label: "Target Actor",
      value: properties.targetActorId, defaultValue: null,
      displayLabel: properties.targetActorId ? context.actorLabel?.(properties.targetActorId) ?? "Missing Actor" : undefined,
      displayType: properties.targetActorId ? "Actor" : undefined,
      placeholder: "Self", visual: { classId: "Actor", family: "class" },
      disabled: !context.onPickActor,
      description: context.onPickActor
        ? "Choose an actor for the cable end. Self uses this cable's frame unless a Target Component is selected."
        : "Use a component in this Class, or choose another actor in Scene Details after placing the Class.",
      onPick: () => context.onPickActor?.(component.id),
      onChange: (value) => update("targetActorId", value || null),
    },
    {
      kind: "enum", id: id("targetComponentId"), label: "Target Component",
      value: selectedComponent ?? "", defaultValue: "",
      options: [{ value: "", label: properties.targetActorId ? "Actor Origin" : "Cable Origin" }, ...targetComponentOptions],
      description: "Optional component on the target actor, or on this actor when Target Actor is Self.",
      onChange: (value) => update("targetComponentId", value || null),
    },
    {
      kind: "vector3", id: id("endPosition"), label: "End Position", value: properties.endPosition,
      defaultValue: defaults.endPosition,
      description: "Local offset in the selected target frame. With no target, this is relative to the cable component.",
      onChange: (value) => update("endPosition", value.slice(0, 3)),
    },
    number("solverIterations", "Solver Iterations", 1, 16, "Constraint passes per substep. Higher values resist stretch at greater CPU cost.", true),
    boolean("enableStiffness", "Enable Stiffness", "Add bending constraints. This increases solver work."),
    number("gravityScale", "Gravity Scale", -100, 100, "Multiplier for scene gravity."),
    {
      kind: "vector3", id: id("cableForce"), label: "Cable Force", value: properties.cableForce,
      defaultValue: defaults.cableForce, description: "Additional world-space acceleration applied to free particles.",
      onChange: (value) => update("cableForce", value.slice(0, 3)),
    },
    number("damping", "Damping", 0, 1, "Fraction of velocity removed per 1/60 second; 0 retains motion and 1 removes it."),
    number("substepTime", "Substep Time", 1 / 120, 1 / 15, "Fixed simulation interval in seconds. Smaller steps cost more."),
    number("maxSubsteps", "Max Substeps", 1, 8, "Maximum catch-up steps per frame, bounding work after a slow frame.", true),
    boolean("enableCollision", "Enable Collision", "Opt into scene collision. Disabled by default to keep large cable counts inexpensive."),
    { ...number("collisionFriction", "Collision Friction", 0, 1, "Tangential velocity removed when contacting scene geometry."), disabled: !properties.enableCollision },
    number("sleepThreshold", "Sleep Threshold", 0, 1, "Particle speed in world units per second below which the cable can sleep. 0 disables sleeping; endpoint or setting changes wake it."),
    number("sleepDelay", "Sleep Delay", 0, 10, "Seconds of low motion before sleeping."),
  ];
}
