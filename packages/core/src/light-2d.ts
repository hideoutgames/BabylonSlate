import { componentAttachmentTransforms } from "./component-attachment";
import type { SerializedComponent, SerializedTransform } from "./scene";

export const LIGHT_2D_CLASS_ID = "Light2DComponent";

/** A Point light falls off over its radius, optionally within a cone; a Global light lights everything evenly. */
export type Light2DKind = "point" | "global";
export const LIGHT_2D_KINDS: readonly Light2DKind[] = ["point", "global"];

/** Authored data only. The view composes the light's world position and direction. */
export type Light2DProperties = {
  enabled: boolean;
  lightKind: Light2DKind;
  /** Display-space colour, each channel in [0, 1]. */
  color: [number, number, number];
  intensity: number;
  /** World units from the light's origin to where it reaches nothing (Point). */
  radius: number;
  /** World units within which the light is at full intensity, at most `radius` (Point). */
  innerRadius: number;
  /** The cone's full angle in degrees, 360 for every direction; it points along the light's +Y (Point). */
  outerAngle: number;
  /** The full-intensity part of the cone in degrees, at most `outerAngle` (Point). */
  innerAngle: number;
  /** Solid 2D colliders block the light (Point): what lies behind them, as seen from the light, is in shadow. */
  castShadows: boolean;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function parseLight2DProperties(value: unknown): Light2DProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const color = Array.isArray(source.color) && source.color.length === 3 && source.color.every(finite)
    ? source.color.map((channel: number) => clamp(channel, 0, 1)) as [number, number, number]
    : [1, 1, 1] as [number, number, number];
  const radius = finite(source.radius) && source.radius > 0 ? source.radius : 3;
  const outerAngle = finite(source.outerAngle) && source.outerAngle > 0 ? Math.min(360, source.outerAngle) : 360;
  return {
    enabled: source.enabled !== false,
    lightKind: source.lightKind === "global" ? "global" : "point",
    color,
    intensity: finite(source.intensity) ? Math.max(0, source.intensity) : 1,
    radius,
    innerRadius: finite(source.innerRadius) ? clamp(source.innerRadius, 0, radius) : 0,
    outerAngle,
    innerAngle: finite(source.innerAngle) ? clamp(source.innerAngle, 0, outerAngle) : outerAngle,
    castShadows: source.castShadows !== false,
  };
}

export type Light2DBinding = {
  id: string;
  properties: Light2DProperties;
  /** Component local transforms, from the light to the actor origin; never the actor's world twice. */
  transforms: SerializedTransform[];
  error?: string;
};

/** The actor's 2D lights, each with its attachment chain (non-rendering parents included). */
export function light2DBindings(components: readonly SerializedComponent[]): Light2DBinding[] {
  const byId = new Map(components.map((component) => [component.id, component]));
  return components.filter((component) => component.classId === LIGHT_2D_CLASS_ID).map((component) => {
    const chain = componentAttachmentTransforms(component, byId);
    const binding: Light2DBinding = { id: component.id, properties: parseLight2DProperties(component.properties), transforms: chain.transforms };
    if (chain.error === "cyclic") binding.error = "2D Light has a cyclic component attachment.";
    if (chain.error === "missing") binding.error = "2D Light has a missing component attachment.";
    return binding;
  });
}

/** Whether any of `actors` holds a 2D Light: its Scene's 2D surfaces draw lit by 2D lights. */
export function actorsHaveLights2D(actors: readonly { components: readonly { classId: string }[] }[]): boolean {
  return actors.some((actor) => actor.components.some((component) => component.classId === LIGHT_2D_CLASS_ID));
}
