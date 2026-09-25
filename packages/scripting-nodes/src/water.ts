import { pin, type NodeDefinition, EXEC, VEC3, BOOL, FLOAT, actorRef } from "@babylonslate/scripting";

/** One coherent sample, shared with the native buoyancy simulation. */
export const waterNodes: NodeDefinition[] = [{
  id: "water.sampleSurface",
  title: "Sample Water Surface",
  category: "physics",
  searchAliases: ["water", "buoyancy", "waves", "current", "immersion"],
  pins: () => [
    pin("execIn", "Exec", "in", EXEC),
    pin("execOut", "Then", "out", EXEC),
    pin("position", "World Position", "in", VEC3),
    pin("waterActor", "Water Actor", "in", actorRef("Actor"), "data", true, null),
    pin("found", "Found", "out", BOOL),
    pin("height", "Surface Height", "out", FLOAT),
    pin("depth", "Immersion Depth", "out", FLOAT),
    pin("normal", "Surface Normal", "out", VEC3),
    pin("velocity", "Water Velocity", "out", VEC3),
    pin("edgeDistance", "Bank Distance", "out", FLOAT),
    pin("actor", "Water Actor", "out", actorRef("Actor")),
  ],
  codegen: (ctx) => {
    const assignments = ["found", "height", "depth", "normal", "velocity", "edgeDistance", "actor"]
      .map((key) => `${ctx.output(key)} = __water.${key};`).join(" ");
    ctx.emit(`{ const __water = ctx.sampleWater(${ctx.input("position")}, ${ctx.input("waterActor")}); ${assignments} }`);
  },
}];
