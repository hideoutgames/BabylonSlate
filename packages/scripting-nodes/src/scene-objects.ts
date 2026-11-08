import {
  BOOL,
  EXEC,
  FLOAT,
  ROTATOR,
  STRING,
  TAG,
  TAG_CONTAINER,
  TRANSFORM,
  VEC3,
  arrayOf,
  classRef,
  objectRef,
  pin,
  type CodegenContext,
  type GraphPin,
  type NodeDefinition,
} from "@haptic/scripting";
import { selfActorPin, subject } from "./self-pin";

/**
 * Visibility, component transforms, actor offsets and rotations, actor Tags and class reads. Each
 * compiles to a `ctx` member in `runtime/src/script-object-members.ts`.
 */

const ZERO = "{ x: 0, y: 0, z: 0 }";
const ONE = "{ x: 1, y: 1, z: 1 }";
const IDENTITY = `{ position: ${ZERO}, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: ${ONE} }`;

const execPins = (): GraphPin[] => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];
const componentTarget = (): GraphPin => subject(pin("target", "Target", "in", objectRef("ActorComponent")));
const input = (id: string, name: string, type: GraphPin["type"], defaultValue?: unknown): GraphPin =>
  pin(id, name, "in", type, "data", defaultValue !== undefined, defaultValue);

type Space = "relative" | "world";
type Channel = "position" | "rotation" | "scale" | "transform";
const SPACE_TITLE: Record<Space, string> = { relative: "Relative", world: "World" };
const CHANNELS: ReadonlyArray<{ channel: Channel; id: string; title: string; type: GraphPin["type"]; read: (transform: string) => string; fallback?: unknown }> = [
  { channel: "position", id: "Location", title: "Location", type: VEC3, read: (t) => `(${t}?.position ?? ${ZERO})`, fallback: { x: 0, y: 0, z: 0 } },
  { channel: "rotation", id: "Rotation", title: "Rotation", type: ROTATOR, read: (t) => `ctx.quatToRotator(${t}?.rotation)`, fallback: { pitch: 0, yaw: 0, roll: 0 } },
  { channel: "scale", id: "Scale", title: "Scale", type: VEC3, read: (t) => `(${t}?.scale ?? ${ONE})`, fallback: { x: 1, y: 1, z: 1 } },
  { channel: "transform", id: "Transform", title: "Transform", type: TRANSFORM, read: (t) => `(${t} ?? ${IDENTITY})` },
];

function componentTransformNodes(): NodeDefinition[] {
  const nodes: NodeDefinition[] = [];
  for (const space of ["relative", "world"] as const) {
    for (const entry of CHANNELS) {
      const title = `${SPACE_TITLE[space]} ${entry.title}`;
      nodes.push({
        id: `transform.getComponent${SPACE_TITLE[space]}${entry.id}`,
        title: `Get Component ${title}`,
        category: "transform",
        pure: true,
        description: space === "relative"
          ? `Returns the component's ${entry.title.toLowerCase()} relative to the component it is attached to, or to its actor.`
          : `Returns the component's ${entry.title.toLowerCase()} in the world.`,
        pins: () => [componentTarget(), pin("out", title, "out", entry.type)],
        codegen: (ctx) => ({ out: entry.read(`ctx.componentTransform(${ctx.input("target")}, ${JSON.stringify(space)})`) }),
      });
      nodes.push({
        id: `transform.setComponent${SPACE_TITLE[space]}${entry.id}`,
        title: `Set Component ${title}`,
        category: "transform",
        description: space === "relative"
          ? `Sets the component's ${entry.title.toLowerCase()} relative to the component it is attached to, or to its actor.`
          : `Sets the component's ${entry.title.toLowerCase()} in the world; it stays attached and keeps that place until its parent moves.`,
        pins: () => [...execPins(), componentTarget(), input("value", `New ${entry.title}`, entry.type, entry.fallback)],
        codegen: (ctx) => {
          ctx.emit(`ctx.setComponentTransform(${ctx.input("target")}, ${JSON.stringify(entry.channel)}, ${ctx.input("value")}, ${JSON.stringify(space)});`);
        },
      });
    }
  }
  for (const [axis, member] of [["Forward", "rotatorForward"], ["Right", "rotatorRight"], ["Up", "rotatorUp"]] as const) {
    nodes.push({
      id: `transform.component${axis}`,
      title: `Get Component ${axis} Vector`,
      category: "transform",
      pure: true,
      description: `Returns the component's ${axis.toLowerCase()} direction in the world, of length 1.`,
      pins: () => [componentTarget(), pin("out", "Out", "out", VEC3)],
      codegen: (ctx) => ({ out: `ctx.${member}(ctx.quatToRotator(ctx.componentTransform(${ctx.input("target")}, "world")?.rotation))` }),
    });
  }
  return nodes;
}

function execNode(id: string, title: string, category: string, description: string, inputs: GraphPin[], statement: (ctx: CodegenContext) => string): NodeDefinition {
  return {
    id, title, category, description,
    pins: () => [...execPins(), ...inputs],
    codegen: (ctx) => {
      ctx.emit(statement(ctx));
    },
  };
}

export const sceneObjectNodes: NodeDefinition[] = [
  // Visibility
  execNode("actor.setHiddenInGame", "Set Actor Hidden In Game", "actor",
    "Hides or shows the actor and all its components. Actors attached to it keep their own visibility; collision is unchanged.",
    [selfActorPin("target", "Target"), input("hidden", "New Hidden", BOOL, true)],
    (ctx) => `ctx.setActorHidden(${ctx.input("target")}, ${ctx.input("hidden")});`),
  {
    id: "actor.isHiddenInGame",
    title: "Is Actor Hidden In Game",
    category: "actor",
    pure: true,
    pins: () => [selfActorPin("target", "Target"), pin("hidden", "Hidden", "out", BOOL)],
    codegen: (ctx) => ({ hidden: `ctx.isActorHidden(${ctx.input("target")})` }),
  },
  execNode("component.setVisibility", "Set Visibility", "component",
    "Shows or hides what the component draws. It keeps its place, so attached components follow it; Propagate To Children applies the same to them.",
    [componentTarget(), input("visible", "New Visibility", BOOL, false), input("propagate", "Propagate To Children", BOOL, false)],
    (ctx) => `ctx.setComponentVisible(${ctx.input("target")}, ${ctx.input("visible")}, ${ctx.input("propagate")});`),
  {
    id: "component.isVisible",
    title: "Is Visible",
    category: "component",
    pure: true,
    pins: () => [componentTarget(), pin("visible", "Visible", "out", BOOL)],
    codegen: (ctx) => ({ visible: `ctx.isComponentVisible(${ctx.input("target")})` }),
  },
  // Component transforms
  ...componentTransformNodes(),
  // Actor offsets, rotations and distance
  execNode("transform.addLocalOffset", "Add Actor Local Offset", "transform",
    "Moves the actor along its own axes, as its rotation turns them; its scale does not stretch the move.",
    [selfActorPin("target", "Target"), input("offset", "Delta Location", VEC3, { x: 0, y: 0, z: 0 })],
    (ctx) => `ctx.addActorLocalOffset(${ctx.input("target")}, ${ctx.input("offset")});`),
  execNode("transform.addLocalRotation", "Add Actor Local Rotation", "transform",
    "Turns the actor about its own axes.",
    [selfActorPin("target", "Target"), input("rotation", "Delta Rotation", ROTATOR, { pitch: 0, yaw: 0, roll: 0 })],
    (ctx) => `ctx.addActorLocalRotation(${ctx.input("target")}, ${ctx.input("rotation")});`),
  execNode("transform.addWorldRotation", "Add Actor World Rotation", "transform",
    "Turns the actor about the world's axes.",
    [selfActorPin("target", "Target"), input("rotation", "Delta Rotation", ROTATOR, { pitch: 0, yaw: 0, roll: 0 })],
    (ctx) => `ctx.addActorWorldRotation(${ctx.input("target")}, ${ctx.input("rotation")});`),
  execNode("transform.teleport", "Teleport", "transform",
    "Moves and turns the actor at once, without sweeping through what lies between.",
    [selfActorPin("target", "Target"), input("location", "Dest Location", VEC3, { x: 0, y: 0, z: 0 }),
      input("rotation", "Dest Rotation", ROTATOR, { pitch: 0, yaw: 0, roll: 0 }), input("reset", "Reset Velocity", BOOL, false)],
    (ctx) => `ctx.teleportActor(${ctx.input("target")}, ${ctx.input("location")}, ${ctx.input("rotation")}, ${ctx.input("reset")});`),
  {
    id: "actor.getDistanceTo",
    title: "Get Distance To",
    category: "actor",
    pure: true,
    description: "Returns the distance between the two actors' world locations, or 0 when either is missing.",
    pins: () => [selfActorPin("target", "Target"), pin("other", "Other Actor", "in", objectRef("Actor")), pin("distance", "Distance", "out", FLOAT)],
    codegen: (ctx) => ({ distance: `ctx.actorDistance(${ctx.input("target")}, ${ctx.input("other")})` }),
  },
  // Actor Tags
  {
    id: "tags.getActorTags",
    title: "Get Actor Tags",
    category: "tags",
    pure: true,
    description: "Returns the actor's Tags: its Class's Tags, the placed actor's own, or what scripts set since.",
    pins: () => [selfActorPin("target", "Target"), pin("tags", "Tags", "out", TAG_CONTAINER)],
    codegen: (ctx) => ({ tags: `ctx.getActorTags(${ctx.input("target")})` }),
  },
  {
    id: "tags.actorHasTag",
    title: "Actor Has Tag",
    category: "tags",
    pure: true,
    description: "True when one of the actor's Tags is Tag or, unless Exact Match is on, a child of it.",
    pins: () => [selfActorPin("target", "Target"), input("tag", "Tag", TAG, 0), input("exact", "Exact Match", BOOL, false), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `__tags.has(ctx.getActorTags(${ctx.input("target")}), ${ctx.input("tag")}, ${ctx.input("exact")})` }),
  },
  execNode("tags.addActorTag", "Add Actor Tag", "tags", "Gives the actor Tag for the rest of its life, unless removed.",
    [selfActorPin("target", "Target"), input("tag", "Tag", TAG, 0)],
    (ctx) => `{ const __a = ${ctx.input("target")}; ctx.setActorTags(__a, __tags.add(ctx.getActorTags(__a), ${ctx.input("tag")})); }`),
  execNode("tags.removeActorTag", "Remove Actor Tag", "tags", "Takes Tag off the actor; its child Tags stay.",
    [selfActorPin("target", "Target"), input("tag", "Tag", TAG, 0)],
    (ctx) => `{ const __a = ${ctx.input("target")}; ctx.setActorTags(__a, __tags.remove(ctx.getActorTags(__a), ${ctx.input("tag")})); }`),
  {
    id: "tags.getAllActorsWithTag",
    title: "Get All Actors With Tag",
    category: "tags",
    pure: true,
    description: "Returns every actor with Tag or, unless Exact Match is on, a child of it, in spawn order.",
    pins: () => [input("tag", "Tag", TAG, 0), input("exact", "Exact Match", BOOL, false), pin("actors", "Actors", "out", arrayOf(objectRef("Actor")))],
    codegen: (ctx) => ({
      actors: `((__t, __e) => ctx.getAllActorsOfClass("Actor").filter((__a) => __tags.has(ctx.getActorTags(__a), __t, __e)))(${ctx.input("tag")}, ${ctx.input("exact")})`,
    }),
  },
  // Classes
  {
    id: "object.getClass",
    title: "Get Class",
    category: "object",
    pure: true,
    description: "Returns the object's Class, or None for a missing object.",
    pins: () => [subject(pin("object", "Object", "in", objectRef("Object"))), pin("class", "Class", "out", classRef("Object"))],
    codegen: (ctx) => ({ class: `ctx.getObjectClass(${ctx.input("object")})` }),
  },
  {
    id: "object.classIsChildOf",
    title: "Class Is Child Of",
    category: "object",
    pure: true,
    description: "True when Test Class is Parent Class or one of its child Classes.",
    pins: () => [pin("testClass", "Test Class", "in", classRef("Object")), pin("parentClass", "Parent Class", "in", classRef("Object")), pin("out", "Result", "out", BOOL)],
    codegen: (ctx) => ({ out: `ctx.classIsChildOf(${ctx.input("testClass")}, ${ctx.input("parentClass")})` }),
  },
  {
    id: "object.getDisplayName",
    title: "Get Display Name",
    category: "object",
    pure: true,
    description: "Returns an actor's or component's name, or the Class of any other object.",
    pins: () => [subject(pin("object", "Object", "in", objectRef("Object"))), pin("name", "Name", "out", STRING)],
    codegen: (ctx) => ({ name: `ctx.getDisplayName(${ctx.input("object")})` }),
  },
];
