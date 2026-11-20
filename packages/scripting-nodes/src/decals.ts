import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  ROTATOR,
  VEC3,
  assetRef,
} from "@haptic/scripting";

/** Runtime decal projection nodes backed by the renderer's pooled dynamic decal ring buffer. */
export const decalNodes: NodeDefinition[] = [
  {
    id: "decals.spawn",
    title: "Spawn Decal",
    category: "render",
    description: "Projects a pooled runtime decal onto world surfaces at a location and orientation. Set Lifetime above 0 to expire and optionally fade out automatically.",
    searchAliases: ["spawn decal", "project decal", "bullet hole", "footprint", "scorch"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("texture", "Texture", "in", assetRef("Texture")),
      pin("location", "Location", "in", VEC3),
      pin("rotation", "Rotation", "in", ROTATOR),
      pin("size", "Size", "in", VEC3, "data", true, { x: 1, y: 1, z: 1 }),
      pin("lifetime", "Lifetime", "in", FLOAT, "data", true, 10),
      pin("fadeOutDuration", "Fade Out Duration", "in", FLOAT, "data", true, 1),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.spawnDecal(${ctx.input("texture")}, ${ctx.input("location")}, ${ctx.input("rotation")}, ${ctx.input("size")}, ${ctx.input("lifetime")}, ${ctx.input("fadeOutDuration")});`,
      );
    },
  },
];
