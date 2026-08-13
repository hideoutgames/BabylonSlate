import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  TypeVisualIcon,
  engineParentOf,
  resolveActorTypeVisual,
  resolveTypeVisual,
  walkAncestry,
} from "./type-visuals";

describe("resolveTypeVisual", () => {
  it("gives Scene, Texture, Graph, and Class distinct colors", () => {
    const scene = resolveTypeVisual({ assetType: "Scene" });
    const texture = resolveTypeVisual({ assetType: "Texture" });
    const graph = resolveTypeVisual({ assetType: "Graph" });
    const classAsset = resolveTypeVisual({ assetType: "Class" });
    const colors = new Set(
      [scene, texture, graph, classAsset].map((visual) => visual.colorVar),
    );
    expect(colors.size).toBe(4);
    expect(scene.colorVar).toBe("var(--asset-scene)");
    expect(texture.colorVar).toBe("var(--asset-texture)");
    expect(graph.colorVar).toBe("var(--asset-graph)");
    expect(classAsset.colorVar).toBe("var(--asset-class)");
  });

  it("uses the folder asset color for folder visuals", () => {
    expect(resolveTypeVisual({ family: "folder" }).colorVar).toBe(
      "var(--asset-folder)",
    );
  });

  it("shares script-type color across Enum, Structure, and ScriptInterface", () => {
    const enumVisual = resolveTypeVisual({ assetType: "Enum" });
    const structVisual = resolveTypeVisual({ assetType: "Structure" });
    const ifaceVisual = resolveTypeVisual({ assetType: "ScriptInterface" });
    expect(enumVisual.colorVar).toBe("var(--asset-script-type)");
    expect(structVisual.colorVar).toBe(enumVisual.colorVar);
    expect(ifaceVisual.colorVar).toBe(enumVisual.colorVar);
    expect(enumVisual.icon).not.toBe(structVisual.icon);
    expect(structVisual.icon).not.toBe(ifaceVisual.icon);
  });

  it("shares Class color for Object, Actor, and Widget with different icons", () => {
    const objectVisual = resolveTypeVisual({ classId: "BObject" });
    const actorVisual = resolveTypeVisual({ classId: "Actor" });
    const widgetVisual = resolveTypeVisual({
      classId: "WidgetComponent",
      family: "class",
    });
    expect(objectVisual.colorVar).toBe("var(--asset-class)");
    expect(actorVisual.colorVar).toBe(objectVisual.colorVar);
    expect(widgetVisual.colorVar).toBe(objectVisual.colorVar);
    expect(objectVisual.icon).not.toBe(actorVisual.icon);
    expect(actorVisual.icon).not.toBe(widgetVisual.icon);
    expect(objectVisual.icon).not.toBe(widgetVisual.icon);
  });

  it("reuses the Object icon for GameInstance, FunctionLibrary, ActorComponent, and BDebugCommand", () => {
    const objectIcon = resolveTypeVisual({ classId: "BObject" }).icon;
    expect(resolveTypeVisual({ classId: "GameInstance" }).icon).toBe(objectIcon);
    expect(resolveTypeVisual({ classId: "FunctionLibrary" }).icon).toBe(
      objectIcon,
    );
    expect(resolveTypeVisual({ classId: "ActorComponent" }).icon).toBe(
      objectIcon,
    );
    expect(resolveTypeVisual({ classId: "BDebugCommand" }).icon).toBe(
      objectIcon,
    );
    expect(engineParentOf("BDebugCommand")).toBe("BObject");
  });

  it("uses Class color and the parent icon for Class assets", () => {
    const actorClass = resolveTypeVisual({
      assetType: "Class",
      parentClass: "Actor",
    });
    expect(actorClass.colorVar).toBe("var(--asset-class)");
    expect(actorClass.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
  });

  it("walks ancestry so user classes inherit the parent engine icon", () => {
    const mesh = resolveTypeVisual({ classId: "MeshComponent" });
    const userMesh = resolveTypeVisual({
      assetType: "Class",
      ancestry: ["MyMesh", "MeshComponent", "ActorComponent", "BObject"],
    });
    expect(userMesh.colorVar).toBe("var(--asset-class)");
    expect(userMesh.icon).toBe(mesh.icon);
    expect(userMesh.icon).not.toBe(
      resolveTypeVisual({ classId: "ActorComponent" }).icon,
    );
  });

  it("does not advertise unbuilt behaviour-tree or nav as distinct component glyphs", () => {
    const actorComponent = resolveTypeVisual({ classId: "ActorComponent" });
    for (const classId of ["BehaviourTreeComponent", "NavAgentComponent"]) {
      const visual = resolveTypeVisual({ classId });
      expect(visual.iconKey).not.toBe(classId);
      expect(visual.icon).toBe(actorComponent.icon);
    }
  });

  it("uses a distinct glyph for TilemapComponent now that P10 Play load exists", () => {
    const visual = resolveTypeVisual({ classId: "TilemapComponent" });
    expect(visual.iconKey).toBe("TilemapComponent");
    expect(visual.family).toBe("component");
  });

  it("gives Tileset and Tilemap assets distinct glyphs", () => {
    const tileset = resolveTypeVisual({ assetType: "Tileset" });
    const tilemap = resolveTypeVisual({ assetType: "Tilemap" });
    expect(tileset.family).toBe("texture");
    expect(tilemap.family).toBe("texture");
    expect(tileset.iconKey).toBe("Tileset");
    expect(tilemap.iconKey).toBe("Tilemap");
    expect(tileset.icon).not.toBe(tilemap.icon);
  });

  it("uses component color for engine components unless family is overridden", () => {
    const mesh = resolveTypeVisual({ classId: "MeshComponent" });
    const light = resolveTypeVisual({ classId: "LightComponent" });
    expect(mesh.family).toBe("component");
    expect(mesh.colorVar).toBe("var(--asset-component)");
    expect(light.colorVar).toBe(mesh.colorVar);
    expect(mesh.icon).not.toBe(light.icon);
    expect(
      resolveTypeVisual({ classId: "MeshComponent", family: "class" }).colorVar,
    ).toBe("var(--asset-class)");
  });

  it("falls back to a muted file glyph for unknown types", () => {
    const unknown = resolveTypeVisual({ assetType: "NotARealType" });
    expect(unknown.family).toBe("unknown");
    expect(unknown.colorVar).toBe("var(--muted-foreground)");
    expect(unknown.icon).toBe(resolveTypeVisual({}).icon);
  });
});

describe("walkAncestry", () => {
  it("walks parent links from most specific to root", () => {
    const parents = new Map<string, string | null>([
      ["MyHero", "HeroBase"],
      ["HeroBase", "Actor"],
      ["Actor", "BObject"],
      ["BObject", null],
    ]);
    expect(walkAncestry("MyHero", (id) => parents.get(id))).toEqual([
      "MyHero",
      "HeroBase",
      "Actor",
      "BObject",
    ]);
  });
});

describe("resolveActorTypeVisual", () => {
  it("uses the Actor parent icon for user actor classes even when they have a mesh", () => {
    const visual = resolveActorTypeVisual({
      classId: "MyHero",
      ancestry: ["MyHero", "Actor", "BObject"],
      components: [{ classId: "MeshComponent" }],
    });
    expect(visual.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
    expect(visual.colorVar).toBe("var(--asset-class)");
  });

  it("uses the component icon with Actor color for engine Actor placeholders", () => {
    const boxed = resolveActorTypeVisual({
      classId: "Actor",
      components: [{ classId: "MeshComponent" }],
    });
    expect(boxed.icon).toBe(
      resolveTypeVisual({ classId: "MeshComponent" }).icon,
    );
    expect(boxed.colorVar).toBe("var(--asset-class)");
  });
});

describe("TypeVisualIcon", () => {
  afterEach(() => {
    cleanup();
  });

  it("paints the glyph with the resolved CSS variable", () => {
    const visual = resolveTypeVisual({ assetType: "Scene" });
    const { getByTestId } = render(
      <TypeVisualIcon visual={visual} data-testid="glyph" />,
    );
    const glyph = getByTestId("glyph");
    expect(glyph.getAttribute("data-type-family")).toBe("scene");
    expect(glyph.getAttribute("data-type-icon")).toBe("Scene");
    expect(glyph.style.color).toBe("var(--asset-scene)");
  });
});
