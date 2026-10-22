import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  STRING,
  actorRef,
  arrayOf,
  enumRef,
  ENGINE_NAV_OBSTACLE_KIND_ENUM_ID,
} from "@haptic/scripting";
import { subject } from "./self-pin";

/**
 * A navigation point query: the host returns null on a miss. Found reports
 * the miss and the Vector3 output stays a zero vector, never null.
 */
function emitNavPoint(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
  pointPin: string,
  query: string,
): void {
  const point = ctx.output(pointPin);
  const found = ctx.output("found");
  ctx.emit(
    `{ const __point = ${query}; ${found} = __point != null; ${point} = __point ?? { x: 0, y: 0, z: 0 }; }`,
  );
}

/** Navigation query and crowd nodes — sync on the calling execution pin (P11). */
export const navigationNodes: NodeDefinition[] = [
  {
    id: "navigation.findPathTo",
    title: "Find Path To",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("from", "from", "in", VEC3),
      pin("to", "to", "in", VEC3),
      pin("path", "path", "out", arrayOf(VEC3)),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("path")} = ctx.findPathTo(${ctx.input("from")}, ${ctx.input("to")});`,
      );
    },
  },
  {
    id: "navigation.moveTo",
    title: "Move To",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", actorRef("Actor"))),
      pin("destination", "destination", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.moveTo(${ctx.input("target")}, ${ctx.input("destination")});`,
      );
    },
  },
  {
    id: "navigation.stopMovement",
    title: "Stop Movement",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", actorRef("Actor"))),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.stopMovement(${ctx.input("target")});`);
    },
  },
  {
    id: "navigation.isPathValid",
    title: "Is Path Valid",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("from", "from", "in", VEC3),
      pin("to", "to", "in", VEC3),
      pin("valid", "valid", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("valid")} = ctx.isPathValid(${ctx.input("from")}, ${ctx.input("to")});`,
      );
    },
  },
  {
    id: "navigation.getClosestNavigablePoint",
    title: "Get Closest Navigable Point",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("point", "point", "in", VEC3),
      pin("closest", "closest", "out", VEC3),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      emitNavPoint(ctx, "closest", `ctx.getClosestNavigablePoint(${ctx.input("point")})`);
    },
  },
  {
    id: "navigation.getRandomPointInRadius",
    title: "Get Random Point In Radius",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("center", "center", "in", VEC3),
      pin("radius", "radius", "in", FLOAT),
      pin("point", "point", "out", VEC3),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      emitNavPoint(ctx, "point", `ctx.getRandomPointInRadius(${ctx.input("center")}, ${ctx.input("radius")})`);
    },
  },
  {
    id: "navigation.addObstacle",
    title: "Add Obstacle",
    category: "navigation",
    description:
      "Carve an unwalkable box or cylinder. Pose is the volume center and Size its full extent (a cylinder uses its X/Z size as diameters and Y as height). The id is empty when nothing was carved.",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("kind", "kind", "in", enumRef(ENGINE_NAV_OBSTACLE_KIND_ENUM_ID), "data", false, "box"),
      pin("pose", "pose", "in", VEC3),
      pin("size", "size", "in", VEC3),
      pin("id", "id", "out", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("id")} = ctx.addObstacle(${ctx.input("kind")}, ${ctx.input("pose")}, ${ctx.input("size")});`,
      );
    },
  },
  {
    id: "navigation.removeObstacle",
    title: "Remove Obstacle",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("id", "id", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.removeObstacle(${ctx.input("id")});`);
    },
  },
];
