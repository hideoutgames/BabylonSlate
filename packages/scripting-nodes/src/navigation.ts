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
} from "@babylonslate/scripting";

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
      pin("target", "target", "in", actorRef("Actor")),
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
      pin("target", "target", "in", actorRef("Actor")),
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
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("closest")} = ctx.getClosestNavigablePoint(${ctx.input("point")});`,
      );
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
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("point")} = ctx.getRandomPointInRadius(${ctx.input("center")}, ${ctx.input("radius")});`,
      );
    },
  },
  {
    id: "navigation.addObstacle",
    title: "Add Obstacle",
    category: "navigation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("kind", "kind", "in", STRING),
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
