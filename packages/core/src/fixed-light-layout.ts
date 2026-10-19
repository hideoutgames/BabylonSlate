import type { ShadowSettings } from "./shadows";

/**
 * Fixed-shape forward lighting: every lit shader is built once for a fixed row
 * of light seats, grouped in classes by the shadow sampler they bind, and
 * lights take and leave seats without new shaders. This module sizes that row
 * from the device, the shadow settings and the Scene's light inventory; the
 * renderer seats lights in it. Babylon-free.
 */

/** Light kinds a fixed layout seats. */
export const FIXED_LIGHT_KINDS = ["directional", "hemispheric", "spot", "point", "area"] as const;
export type FixedLightKind = (typeof FIXED_LIGHT_KINDS)[number];

/** Lights with shadow maps; a map's kind is its light's (cascades or one map, 2D, cube). */
export type FixedLightShadowKind = "directional" | "spot" | "point";

/**
 * Device classes with their own seat caps: WebGL2 (also the non-UBO fallback);
 * WebGPU at the default uniform-buffer limit (8 slots, D3D12 adapters); and
 * WebGPU whose adapter grants more (Apple GPUs, 16 slots).
 */
export type FixedLightDeviceClass = "webgl2" | "webgpu" | "webgpuRaised";

/** WebGPU light slots at the default 12 uniform buffers per stage, less Scene, Mesh, Material and LeftOver. */
export const WEBGPU_DEFAULT_LIGHT_SLOTS = 8;

/**
 * Most seats on raised-limit WebGPU (Apple GPUs). The full 16 slots until the
 * iPad benchmark decides whether a smaller design cap (such as 12) pays off.
 */
export const RAISED_WEBGPU_FIXED_LIGHT_SEATS = 16;

/** The cap column a device uses, from its Forward light budget. */
export function fixedLightDeviceClass(device: { webgpu: boolean; slots: number }): FixedLightDeviceClass {
  if (!device.webgpu) return "webgl2";
  return device.slots > WEBGPU_DEFAULT_LIGHT_SLOTS ? "webgpuRaised" : "webgpu";
}

/**
 * One seat class. The list is data: classes are sized, trimmed and filled
 * generically, so a class can be split (LOCAL into LOCAL_SPOT and LOCAL_POINT)
 * without code changes.
 */
export interface FixedLightClassSpec {
  /** Stable name; the layout key lists classes by it in canonical order. */
  readonly id: string;
  /** Light kinds a seat hosts. */
  readonly hosts: readonly FixedLightKind[];
  /** The kind of shadow map every seat samples. */
  readonly shadow?: FixedLightShadowKind;
  /**
   * What sizes the class: "lights" are the hosted lights the classes before it
   * leave over (plain lights before shadow casters); "shadowCasters" are the
   * shadow casters of its shadow kind. A shadow class seats lights holding a
   * map of its kind first and hosts its other lights with the shadow off; its
   * seats together never exceed the shadow profile's local shadow lights.
   */
  readonly sizedBy: "lights" | "shadowCasters";
  /**
   * Most seats per device class. "remainder" takes the slots the capped
   * classes leave; it is sized after them and binds no sampler.
   */
  readonly caps: Readonly<Record<FixedLightDeviceClass, number | "remainder">>;
  /** Samplers each seat's shadow map binds, per filter (cube maps always filter with Poisson). */
  readonly shadowSamplers?: Readonly<Record<ShadowSettings["filter"], number>>;
  /** Samplers the class binds once while it has seats (area lookup tables). */
  readonly sharedSamplers?: number;
  /** Samplers each seat binds for its light's texture (area emission), while the inventory holds a textured light. */
  readonly textureSamplers?: number;
  /**
   * Sampler headroom trims, lowest rank first: drop the texture samplers,
   * then seats one at a time, then the shadow of a class sized by lights.
   */
  readonly trim?: Readonly<{ texture?: number; seats?: number; shadow?: number }>;
}

const one = { webgl2: 1, webgpu: 1, webgpuRaised: 1 } as const;

/** The classes in canonical order (design section 2). */
export const FIXED_LIGHT_CLASSES: readonly FixedLightClassSpec[] = [
  {
    id: "SUN",
    hosts: ["directional"],
    shadow: "directional",
    sizedBy: "lights",
    caps: one,
    shadowSamplers: { pcf: 1, pcss: 2 },
    trim: { shadow: 4 },
  },
  { id: "FILL", hosts: ["hemispheric"], sizedBy: "lights", caps: one },
  {
    id: "SPOT_SHADOW",
    hosts: ["spot", "point"],
    shadow: "spot",
    sizedBy: "shadowCasters",
    caps: { webgl2: 2, webgpu: 2, webgpuRaised: 4 },
    shadowSamplers: { pcf: 1, pcss: 2 },
    trim: { seats: 2 },
  },
  {
    id: "POINT_SHADOW",
    hosts: ["spot", "point"],
    shadow: "point",
    sizedBy: "shadowCasters",
    caps: { webgl2: 1, webgpu: 1, webgpuRaised: 2 },
    shadowSamplers: { pcf: 1, pcss: 1 },
    trim: { seats: 1 },
  },
  {
    id: "LOCAL",
    hosts: ["spot", "point"],
    sizedBy: "lights",
    caps: { webgl2: "remainder", webgpu: "remainder", webgpuRaised: "remainder" },
  },
  {
    id: "AREA",
    hosts: ["area"],
    sizedBy: "lights",
    caps: { webgl2: 1, webgpu: 1, webgpuRaised: 2 },
    sharedSamplers: 2,
    textureSamplers: 1,
    trim: { texture: 0, seats: 3 },
  },
];

/** Lights of one kind: all of them, the shadow casters among them, and those with a texture (area emission). */
export interface FixedLightKindCount {
  readonly lights: number;
  readonly shadowCasters: number;
  readonly textured: number;
}
export type FixedLightInventory = Readonly<Record<FixedLightKind, FixedLightKindCount>>;

const NO_LIGHTS: FixedLightKindCount = Object.freeze({ lights: 0, shadowCasters: 0, textured: 0 });
export const EMPTY_FIXED_LIGHT_INVENTORY: FixedLightInventory = Object.freeze({
  directional: NO_LIGHTS,
  hemispheric: NO_LIGHTS,
  spot: NO_LIGHTS,
  point: NO_LIGHTS,
  area: NO_LIGHTS,
});

/**
 * The high-water mark of `high` and `current`, field by field. Returns `high`
 * itself when nothing grew, so a caller can tell growth by identity.
 */
export function growFixedLightInventory(
  high: FixedLightInventory,
  current: FixedLightInventory,
): FixedLightInventory {
  let grown: Record<FixedLightKind, FixedLightKindCount> | undefined;
  for (const kind of FIXED_LIGHT_KINDS) {
    const a = high[kind];
    const b = current[kind];
    if (b.lights <= a.lights && b.shadowCasters <= a.shadowCasters && b.textured <= a.textured) continue;
    grown ??= { ...high };
    grown[kind] = {
      lights: Math.max(a.lights, b.lights),
      shadowCasters: Math.max(a.shadowCasters, b.shadowCasters),
      textured: Math.max(a.textured, b.textured),
    };
  }
  return grown ?? high;
}

export interface FixedLightLayoutInput {
  readonly device: FixedLightDeviceClass;
  /** Light slots the device's uniform-block limits allow. */
  readonly slots: number;
  /** Lighting sampler headroom: the fragment stage's texture units less the material reserve. */
  readonly samplers: number;
  /** Effective shadow settings (device and CEL fallbacks, automatic local-light capacity applied). */
  readonly shadows: Pick<ShadowSettings, "filter" | "cascades" | "maxLocalLights">;
  /**
   * The Scene's light inventory high-water mark: every light, enabled or not,
   * and the shadow casters counted while scene shadows were on.
   */
  readonly inventory: FixedLightInventory;
  readonly classes?: readonly FixedLightClassSpec[];
}

export interface FixedLightLayoutClass {
  readonly id: string;
  readonly hosts: readonly FixedLightKind[];
  readonly seats: number;
  /** The shadow map kind the seats sample, or null when they sample none. */
  readonly shadow: FixedLightShadowKind | null;
  /** Lights holding a map of `shadow` take these seats before any other hosted light. */
  readonly shadowClass: boolean;
  /** Seats bind their light's texture (area emission). */
  readonly textured: boolean;
  /** Lighting samplers the class binds on every lit draw. */
  readonly samplers: number;
}

export interface FixedLightLayout {
  readonly device: FixedLightDeviceClass;
  /** Every class in canonical order, including those without seats. */
  readonly classes: readonly FixedLightLayoutClass[];
  readonly seats: number;
  readonly samplers: number;
  readonly filter: ShadowSettings["filter"];
  readonly cascades: number;
  /**
   * Identity: each class's seats, shadow (s) and texture (t) in canonical
   * order, then the filter while any seat samples a map and the cascades while
   * a directional seat does. Shader variants depend on the layout only.
   */
  readonly key: string;
  /** What the shadow profile and the sampler headroom removed, for diagnostics. */
  readonly trims: readonly string[];
}

/**
 * Sizes the layout: each class seats min(cap, inventory) lights, capped
 * classes first in canonical order, then the remainder classes. Shadow classes
 * together stay within the shadow profile's local shadow lights, and the whole
 * layout within the lighting sampler headroom (trims in `trim` order); shadow
 * casters a trimmed seat would have held fall to the remainder classes, where
 * they light unshadowed. A light kind with no seat left is limited.
 */
export function fixedLightLayout(input: FixedLightLayoutInput): FixedLightLayout {
  const specs = input.classes ?? FIXED_LIGHT_CLASSES;
  const filter = input.shadows.filter;
  const deviceCap = input.device === "webgpuRaised" ? RAISED_WEBGPU_FIXED_LIGHT_SEATS : Number.POSITIVE_INFINITY;
  let free = Math.max(0, Math.floor(Math.min(input.slots, deviceCap)));
  // Remaining inventory to seat: plain lights and shadow casters apart.
  const plain = {} as Record<FixedLightKind, number>;
  const casters = {} as Record<FixedLightKind, number>;
  for (const kind of FIXED_LIGHT_KINDS) {
    const count = input.inventory[kind];
    const lights = Math.max(0, Math.floor(count.lights));
    casters[kind] = Math.min(lights, Math.max(0, Math.floor(count.shadowCasters)));
    plain[kind] = lights - casters[kind];
  }
  const seats = specs.map(() => 0);
  // What each seat took, so a trimmed seat returns exactly that light.
  const taken = specs.map((): { kind: FixedLightKind; caster: boolean }[] => []);
  const shadowed = specs.map((spec) =>
    spec.shadow !== undefined &&
    (spec.sizedBy === "shadowCasters" || input.inventory[spec.shadow].shadowCasters > 0));
  const textured = specs.map((spec) =>
    !!spec.textureSamplers && spec.hosts.some((kind) => input.inventory[kind].textured > 0));
  const trims = new Map<string, number>();
  const note = (message: string) => trims.set(message, (trims.get(message) ?? 0) + 1);

  const size = (index: number) => {
    const spec = specs[index]!;
    const cap = spec.caps[input.device];
    const limit = cap === "remainder" ? free : Math.min(Math.max(0, Math.floor(cap)), free);
    for (let seat = 0; seat < limit; seat++) {
      let kind: FixedLightKind | undefined;
      let caster = false;
      if (spec.sizedBy === "shadowCasters") {
        if (spec.shadow && casters[spec.shadow] > 0) {
          kind = spec.shadow;
          caster = true;
        }
      } else {
        kind = spec.hosts.find((host) => plain[host] > 0);
        if (!kind) {
          kind = spec.hosts.find((host) => casters[host] > 0);
          caster = kind !== undefined;
        }
      }
      if (!kind) break;
      if (caster) casters[kind] -= 1;
      else plain[kind] -= 1;
      taken[index]!.push({ kind, caster });
      seats[index] = seats[index]! + 1;
      free -= 1;
    }
  };
  const release = (index: number) => {
    const last = taken[index]!.pop();
    if (!last) return;
    if (last.caster) casters[last.kind] += 1;
    else plain[last.kind] += 1;
    seats[index] = seats[index]! - 1;
    free += 1;
  };
  const classSamplers = (index: number) => {
    const spec = specs[index]!;
    const count = seats[index]!;
    if (!count) return 0;
    return (
      (shadowed[index] ? count * (spec.shadowSamplers?.[filter] ?? 0) : 0) +
      (spec.sharedSamplers ?? 0) +
      (textured[index] ? count * (spec.textureSamplers ?? 0) : 0)
    );
  };
  const spend = () => specs.reduce((total, _spec, index) => total + classSamplers(index), 0);
  const capped = (index: number) => specs[index]!.caps[input.device] !== "remainder";
  const trimRank = (rank: number | undefined) => rank ?? Number.POSITIVE_INFINITY;

  for (let index = 0; index < specs.length; index++) if (capped(index)) size(index);

  // The shadow profile bounds the local shadow seats together.
  const localShadowSeats = () =>
    specs.reduce((total, spec, index) =>
      total + (spec.sizedBy === "shadowCasters" && spec.shadow !== "directional" ? seats[index]! : 0), 0);
  const maxLocal = Math.max(0, Math.floor(input.shadows.maxLocalLights));
  while (localShadowSeats() > maxLocal) {
    let pick = -1;
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]!;
      if (spec.sizedBy !== "shadowCasters" || spec.shadow === "directional" || !seats[index]) continue;
      if (pick < 0 || trimRank(spec.trim?.seats) < trimRank(specs[pick]!.trim?.seats)) pick = index;
    }
    if (pick < 0) break;
    release(pick);
    note(`${specs[pick]!.id}: seat over the shadow profile's ${maxLocal} local shadow lights`);
  }

  // Lighting samplers: trim textures, then seats, then shadows, lowest rank first.
  const budget = Math.max(0, Math.floor(input.samplers));
  type Trim = { index: number; part: "texture" | "seats" | "shadow"; rank: number };
  while (spend() > budget) {
    const options: Trim[] = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]!;
      if (!seats[index]) continue;
      if (textured[index] && spec.trim?.texture !== undefined)
        options.push({ index, part: "texture", rank: spec.trim.texture });
      if (spec.trim?.seats !== undefined) options.push({ index, part: "seats", rank: spec.trim.seats });
      if (shadowed[index] && spec.sizedBy === "lights" && spec.trim?.shadow !== undefined)
        options.push({ index, part: "shadow", rank: spec.trim.shadow });
    }
    const best = options.reduce<Trim | undefined>((pick, option) => (!pick || option.rank < pick.rank ? option : pick), undefined);
    if (!best) break;
    const { index, part } = best;
    const id = specs[index]!.id;
    if (part === "texture") {
      textured[index] = false;
      note(`${id}: textures over the lighting sampler headroom`);
    } else if (part === "seats") {
      release(index);
      note(`${id}: seat over the lighting sampler headroom`);
    } else {
      shadowed[index] = false;
      note(`${id}: shadow over the lighting sampler headroom`);
    }
  }

  for (let index = 0; index < specs.length; index++) if (!capped(index)) size(index);

  const classes = specs.map((spec, index): FixedLightLayoutClass => ({
    id: spec.id,
    hosts: spec.hosts,
    seats: seats[index]!,
    shadow: seats[index]! > 0 && shadowed[index] ? (spec.shadow ?? null) : null,
    shadowClass: spec.sizedBy === "shadowCasters",
    textured: seats[index]! > 0 && textured[index]!,
    samplers: classSamplers(index),
  }));
  const anyShadow = classes.some((entry) => entry.shadow !== null);
  const sunShadow = classes.some((entry) => entry.shadow === "directional");
  const key =
    classes.map((entry) => `${entry.id}${entry.seats}${entry.shadow ? "s" : ""}${entry.textured ? "t" : ""}`).join(",") +
    (anyShadow ? `|${filter}` : "") +
    (sunShadow ? `,c${input.shadows.cascades}` : "");
  return {
    device: input.device,
    classes,
    seats: classes.reduce((total, entry) => total + entry.seats, 0),
    samplers: classes.reduce((total, entry) => total + entry.samplers, 0),
    filter,
    cascades: input.shadows.cascades,
    key,
    trims: [...trims].map(([message, count]) => (count > 1 ? `${message} (${count})` : message)),
  };
}
