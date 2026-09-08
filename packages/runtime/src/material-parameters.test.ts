import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
} from "@babylonslate/core";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";

async function execute(
  source: string,
  twoMeshes = true,
  initial: { materialGuid?: string | null; meshKind?: "box" | "model" } = {},
) {
  const commands: CommandMessage[] = [];
  const mesh = createMeshComponent("mesh-1", initial.meshKind ?? "box");
  mesh.properties.materialGuid =
    initial.materialGuid === undefined ? "mat-rock" : initial.materialGuid;
  const sibling = createMeshComponent("mesh-2", "sphere");
  sibling.properties.materialGuid = "mat-rock";
  const runtime = createInProcessRuntime({
    seed: 1,
    seedDemoActors: false,
    preferSoftwarePhysics: true,
    playScene: {
      name: "Materials",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [
        createActor("prop", "Prop", {
          classId: "Hero",
          components: twoMeshes ? [mesh, sibling] : [mesh],
        }),
      ],
    },
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([
    {
      assetGuid: "hero-script",
      classId: "Hero",
      parentClassId: "Actor",
      source,
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
      ],
    },
  ]);
  runtime.realizePlayWorld();
  runtime.stop();
  return commands;
}

describe("runtime material parameters", () => {
  it("emits a clear between assignments so returning to the same material resets private parameters", async () => {
    const commands = await execute(
      `export function onBeginPlay(ctx) {
      const mesh = ctx.getComponentById(ctx.self, "mesh-1");
      const material = ctx.getVariableFrom(mesh, "materialObject");
      ctx.setMaterialFloatParameter(material, "Roughness", 0.2);
      ctx.setVariableOn(mesh, "materialGuid", null);
      ctx.setVariableOn(mesh, "materialGuid", "mat-rock");
      ctx.setMaterialFloatParameter(material, "Roughness", 0.9);
      const replacement = ctx.getVariableFrom(mesh, "materialObject");
      ctx.setMaterialFloatParameter(replacement, "Roughness", 0.4);
    }`,
      false,
    );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(
      commands
        .filter(
          (command) =>
            command.type === "assignMaterial" ||
            command.type === "setMaterialParameter",
        )
        .map((command) =>
          command.type === "assignMaterial"
            ? [command.type, command.componentId, command.materialAssetGuid]
            : [command.type, command.componentId, command.parameter],
        ),
    ).toEqual([
      ["assignMaterial", "mesh-1", "mat-rock"],
      ["setMaterialParameter", "mesh-1", { kind: "float", value: 0.2 }],
      ["assignMaterial", "mesh-1", null],
      ["assignMaterial", "mesh-1", "mat-rock"],
      ["setMaterialParameter", "mesh-1", { kind: "float", value: 0.4 }],
    ]);
  });

  it("leaves authored model slots untouched when the component never had a material override", async () => {
    const commands = await execute(
      `export function onBeginPlay(ctx) {
      const mesh = ctx.getComponentById(ctx.self, "mesh-1");
      ctx.setVariableOn(mesh, "materialGuid", null);
    }`,
      false,
      { materialGuid: null, meshKind: "model" },
    );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(commands.filter((command) => command.type === "assignMaterial")).toEqual(
      [],
    );
  });

  it("keeps actual component identity while its actor switches between single and multiple visuals", async () => {
    const commands = await execute(
      `export function onBeginPlay(ctx) {
      const mesh = ctx.getComponentById(ctx.self, "mesh-1");
      const material = ctx.getVariableFrom(mesh, "materialObject");
      ctx.setMaterialFloatParameter(material, "Roughness", 0.2);
      const extra = ctx.addComponent(ctx.self, "MeshComponent");
      ctx.setVariableOn(extra, "meshKind", "box");
      ctx.setMaterialFloatParameter(material, "Roughness", 0.3);
      extra.destroyed = true;
      ctx.setVariableOn(mesh, "meshKind", "sphere");
      ctx.setMaterialFloatParameter(material, "Roughness", 0.4);
    }`,
      false,
    );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    const assignments = commands.filter(
      (command): command is Extract<CommandMessage, { type: "assignMesh" }> =>
        command.type === "assignMesh" && command.actorGuid === "prop",
    );
    expect(assignments[0]).toMatchObject({ primaryComponentId: "mesh-1" });
    expect(assignments.some((command) => command.parts?.length === 2)).toBe(
      true,
    );
    expect(assignments.at(-1)).toMatchObject({ primaryComponentId: "mesh-1" });
    expect(assignments.at(-1)?.parts).toBeUndefined();
    expect(
      commands
        .filter((command) => command.type === "setMaterialParameter")
        .map((command) => command.componentId),
    ).toEqual(["mesh-1", "mesh-1", "mesh-1"]);
    expect(
      commands
        .filter((command) => command.type === "assignMaterial")
        .every((command) => command.componentId === "mesh-1"),
    ).toBe(true);
  });

  it("compiles typed setters with literal names and executes their Then chain on the selected mesh", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (
      id: string,
      typeId: string,
      properties: Record<string, unknown> = {},
    ): GraphNode => {
      const definition = registry.get(typeId);
      expect(definition, typeId).toBeDefined();
      return {
        id,
        typeId,
        position: { x: 0, y: 0 },
        properties,
        pins: definition!.pins(properties),
      };
    };
    const nodes = [
      node("begin", "flow.event.beginPlay"),
      node("mesh", "component.getNamed", {
        componentClassId: "MeshComponent",
        implicitSelf: true,
      }),
      node("material", "variables.get", {
        variableName: "Material Object",
        propertyKey: "materialObject",
        typeId: "object",
        typeClassId: "MaterialObject",
        classId: "MeshComponent",
      }),
      node("float", "material.setFloatParameter", {
        "default:name": "Roughness",
        "default:value": 0.4,
      }),
      node("color", "material.setColorParameter", {
        "default:name": "Tint",
        "default:value": { x: 0.1, y: 0.2, z: 0.3, w: 0.5 },
      }),
      node("texture", "material.setTextureParameter", {
        "default:name": "Diffuse",
        "default:value": "texture-brick",
      }),
    ];
    const graph: LogicGraph = {
      id: "material-test",
      kind: "event",
      nodes,
      edges: [
        {
          id: "m",
          sourceNodeId: "mesh",
          sourcePinId: "out",
          targetNodeId: "material",
          targetPinId: "target",
        },
        ...["float", "color", "texture"].flatMap((id, index, ids) => [
          {
            id: `exec-${id}`,
            sourceNodeId: index === 0 ? "begin" : ids[index - 1]!,
            sourcePinId: "execOut",
            targetNodeId: id,
            targetPinId: "execIn",
          },
          {
            id: `target-${id}`,
            sourceNodeId: "material",
            sourcePinId: "value",
            targetNodeId: id,
            targetPinId: "material",
          },
        ]),
      ],
    };
    expect(nodes[3]!.pins.find((pin) => pin.id === "value")?.type).toEqual({
      kind: "float",
    });
    expect(nodes[4]!.pins.find((pin) => pin.id === "value")?.type).toEqual({
      kind: "vec4",
    });
    expect(nodes[5]!.pins.find((pin) => pin.id === "value")?.type).toEqual({
      kind: "assetRef",
      assetType: "Texture",
    });
    const commands = await execute(
      compileGraph(graph, { assetGuid: "hero-script", registry }).source,
    );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(
      commands.filter((command) => command.type === "setMaterialParameter"),
    ).toEqual([
      {
        type: "setMaterialParameter",
        slotId: 0,
        componentId: "mesh-1",
        materialAssetGuid: "mat-rock",
        parameterName: "Roughness",
        parameter: { kind: "float", value: 0.4 },
      },
      {
        type: "setMaterialParameter",
        slotId: 0,
        componentId: "mesh-1",
        materialAssetGuid: "mat-rock",
        parameterName: "Tint",
        parameter: { kind: "color", value: [0.1, 0.2, 0.3, 0.5] },
      },
      {
        type: "setMaterialParameter",
        slotId: 0,
        componentId: "mesh-1",
        materialAssetGuid: "mat-rock",
        parameterName: "Diffuse",
        parameter: { kind: "texture", textureAssetGuid: "texture-brick" },
      },
    ]);
  });

  it("rejects invalid values, missing names, stale references, and destroyed targets", async () => {
    const commands = await execute(
      `export function onBeginPlay(ctx) {
      const mesh = ctx.getComponentById(ctx.self, "mesh-1");
      const material = ctx.getVariableFrom(mesh, "materialObject");
      ctx.setMaterialFloatParameter(material, "", 1);
      ctx.setMaterialFloatParameter(material, "Bad", NaN);
      ctx.setMaterialColorParameter(material, "Bad", {x:0,y:1,z:2,w:Infinity});
      ctx.setMaterialTextureParameter(material, "Bad", {});
      ctx.setMaterialFloatParameter(null, "Bad", 1);
      ctx.setMaterialFloatParameter(mesh, "Bad", 1);
      ctx.setMaterialTextureParameter(material, "Diffuse", null);
      ctx.setVariableOn(mesh, "materialGuid", "mat-other");
      ctx.setMaterialFloatParameter(material, "Stale", 1);
      const replacement = ctx.getVariableFrom(mesh, "materialObject");
      ctx.self.destroyed = true;
      ctx.setMaterialFloatParameter(replacement, "Destroyed", 1);
    }`,
      false,
    );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(
      commands.filter((command) => command.type === "setMaterialParameter"),
    ).toEqual([
      {
        type: "setMaterialParameter",
        slotId: 0,
        componentId: "mesh-1",
        materialAssetGuid: "mat-rock",
        parameterName: "Diffuse",
        parameter: { kind: "texture", textureAssetGuid: null },
      },
    ]);
  });
});
