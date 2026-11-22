import {
  pin,
  type NodeDefinition,
  COLOR,
  EXEC,
  FLOAT,
  ROTATOR,
  VEC3,
  assetRef,
} from "@haptic/scripting";

/** Runtime decal projection nodes backed by the renderer's dynamic decal pool. */
export const decalNodes: NodeDefinition[] = [
  {
    id: "decals.spawn",
    title: "Spawn Decal",
    category: "render",
    description: "Projects a pooled runtime decal of a Decal Material onto world surfaces at a location and orientation. Tint and Opacity multiply the Material's own. Set Lifetime above 0 to expire and optionally fade out automatically.",
    searchAliases: ["spawn decal", "project decal", "bullet hole", "footprint", "scorch"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("material", "Material", "in", assetRef("Material")),
      pin("location", "Location", "in", VEC3),
      pin("rotation", "Rotation", "in", ROTATOR),
      pin("size", "Size", "in", VEC3, "data", true, { x: 1, y: 1, z: 1 }),
      pin("tint", "Tint", "in", COLOR, "data", true, { x: 1, y: 1, z: 1, w: 1 }),
      pin("opacity", "Opacity", "in", FLOAT, "data", true, 1),
      pin("lifetime", "Lifetime", "in", FLOAT, "data", true, 10),
      pin("fadeOutDuration", "Fade Out Duration", "in", FLOAT, "data", true, 1),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.spawnDecal(${ctx.input("material")}, ${ctx.input("location")}, ${ctx.input("rotation")}, ${ctx.input("size")}, ${ctx.input("lifetime")}, ${ctx.input("fadeOutDuration")}, ${ctx.input("tint")}, ${ctx.input("opacity")});`,
      );
    },
  },
];
