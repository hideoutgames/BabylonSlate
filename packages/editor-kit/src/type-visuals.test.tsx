import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  AppWindowIcon,
  FilmIcon,
  ListTreeIcon,
  PanelTopIcon,
  PuzzleIcon,
  Volume2Icon,
  WorkflowIcon,
} from "lucide-react";
import {
  TYPE_VISUAL_ICON_CHROME_SIZE,
  TYPE_VISUAL_ICON_TILE_SIZE,
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
    expect(classAsset.colorVar).toBe("var(--asset-animation)");
  });

  it("uses the folder asset color for folder visuals", () => {
    expect(resolveTypeVisual({ family: "folder" }).colorVar).toBe(
      "var(--asset-folder)",
    );
  });

  it("keeps Enum on script-type and Structure on the old Class color", () => {
    const enumVisual = resolveTypeVisual({ assetType: "Enum" });
    const structVisual = resolveTypeVisual({ assetType: "Structure" });
    const blackboard = resolveTypeVisual({ assetType: "Blackboard" });
    const ifaceVisual = resolveTypeVisual({ assetType: "ScriptInterface" });
    expect(enumVisual.colorVar).toBe("var(--asset-script-type)");
    expect(structVisual.family).toBe("struct");
    expect(structVisual.colorVar).toBe("var(--asset-class)");
    expect(blackboard.family).toBe("struct");
    expect(blackboard.colorVar).toBe(structVisual.colorVar);
    expect(ifaceVisual.colorVar).toBe("var(--asset-animation)");
    expect(enumVisual.icon).not.toBe(structVisual.icon);
    expect(structVisual.icon).not.toBe(ifaceVisual.icon);
  });

  it("gives PluginSettings the Puzzle glyph and script-type color", () => {
    const visual = resolveTypeVisual({ assetType: "PluginSettings" });
    expect(visual.family).toBe("scriptType");
    expect(visual.colorVar).toBe("var(--asset-script-type)");
    expect(visual.iconKey).toBe("PluginSettings");
    expect(visual.icon).toBe(PuzzleIcon);
  });

  it("colors mixer, channel, and attenuation like Scene, Structure, and Class", () => {
    const audio = resolveTypeVisual({ assetType: "Audio" });
    const mixer = resolveTypeVisual({ assetType: "AudioMixer" });
    const channel = resolveTypeVisual({ assetType: "AudioChannel" });
    const atten = resolveTypeVisual({ assetType: "SoundAttenuation" });
    const scene = resolveTypeVisual({ assetType: "Scene" });
    const structure = resolveTypeVisual({ assetType: "Structure" });
    const klass = resolveTypeVisual({ assetType: "Class" });
    expect(audio.family).toBe("class");
    expect(audio.colorVar).toBe("var(--asset-animation)");
    expect(audio.colorVar).toBe(atten.colorVar);
    expect(mixer.family).toBe("scene");
    expect(channel.family).toBe("struct");
    expect(atten.family).toBe("class");
    expect(mixer.icon).toBe(Volume2Icon);
    expect(channel.icon).toBe(Volume2Icon);
    expect(atten.icon).toBe(Volume2Icon);
    expect(audio.icon).toBe(Volume2Icon);
    expect(mixer.colorVar).toBe(scene.colorVar);
    expect(channel.colorVar).toBe(structure.colorVar);
    expect(atten.colorVar).toBe(klass.colorVar);
    expect(mixer.colorVar).not.toBe(audio.colorVar);
    expect(channel.colorVar).not.toBe(audio.colorVar);
  });

  it("treats Mesh assets as the model family", () => {
    const mesh = resolveTypeVisual({ assetType: "Mesh" });
    const model = resolveTypeVisual({ assetType: "Model" });
    expect(mesh.family).toBe("model");
    expect(mesh.icon).toBe(model.icon);
    expect(mesh.colorVar).toBe(model.colorVar);
  });

  it("shares Class color for Object, Actor, and Widget with different icons", () => {
    const objectVisual = resolveTypeVisual({ classId: "BObject" });
    const actorVisual = resolveTypeVisual({ classId: "Actor" });
    const widgetVisual = resolveTypeVisual({
      classId: "WidgetComponent",
      family: "class",
    });
    expect(objectVisual.colorVar).toBe("var(--asset-animation)");
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
    expect(resolveTypeVisual({ classId: "EditorUtilityObject" }).icon).toBe(
      objectIcon,
    );
    expect(resolveTypeVisual({ classId: "EditorFunctionLibrary" }).icon).toBe(
      objectIcon,
    );
    expect(engineParentOf("BDebugCommand")).toBe("BObject");
    expect(engineParentOf("EditorUtilityObject")).toBe("BObject");
    expect(engineParentOf("EditorFunctionLibrary")).toBe("FunctionLibrary");
    expect(engineParentOf("UserInterface")).toBe("BObject");
    expect(engineParentOf("Widget")).toBe("BObject");
    expect(engineParentOf("ButtonWidget")).toBe("Widget");
    expect(engineParentOf("ImageWidget")).toBe("Widget");
  });

  it("uses Class color and the parent icon for Class assets", () => {
    const actorClass = resolveTypeVisual({
      assetType: "Class",
      parentClass: "Actor",
    });
    expect(actorClass.colorVar).toBe("var(--asset-animation)");
    expect(actorClass.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
  });

  it("walks ancestry so user classes inherit the parent engine icon", () => {
    const mesh = resolveTypeVisual({ classId: "MeshComponent" });
    const userMesh = resolveTypeVisual({
      assetType: "Class",
      ancestry: ["MyMesh", "MeshComponent", "ActorComponent", "BObject"],
    });
    expect(userMesh.colorVar).toBe("var(--asset-animation)");
    expect(userMesh.icon).toBe(mesh.icon);
    expect(userMesh.icon).not.toBe(
      resolveTypeVisual({ classId: "ActorComponent" }).icon,
    );
  });

  it("uses distinct glyphs for behaviour-tree and nav components", () => {
    expect(resolveTypeVisual({ classId: "BehaviourTreeComponent" }).iconKey).toBe(
      "BehaviourTreeComponent",
    );
    expect(resolveTypeVisual({ classId: "NavAgentComponent" }).iconKey).toBe(
      "NavAgentComponent",
    );
    expect(resolveTypeVisual({ classId: "NavMeshComponent" }).iconKey).toBe(
      "NavMeshComponent",
    );
    expect(resolveTypeVisual({ classId: "NavMeshBlockerComponent" }).iconKey).toBe(
      "NavMeshBlockerComponent",
    );
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

  it("uses a clean window glyph for UserInterface instead of AppWindow title-bar ticks", () => {
    const visual = resolveTypeVisual({ assetType: "UserInterface" });
    const widget = resolveTypeVisual({ classId: "WidgetComponent" });
    expect(visual.icon).toBe(PanelTopIcon);
    expect(visual.icon).not.toBe(AppWindowIcon);
    expect(widget.icon).toBe(PanelTopIcon);
  });

  it("reuses the Animation Film glyph for Sprite Animation clips", () => {
    const visual = resolveTypeVisual({ assetType: "SpriteAnimation" });
    expect(visual.icon).toBe(FilmIcon);
    expect(visual.family).toBe("animation");
    expect(visual.colorVar).toBe("var(--asset-animation)");
  });

  it("gives AnimationGraph a workflow glyph distinct from clip Animation Film", () => {
    const animation = resolveTypeVisual({ assetType: "Animation" });
    const graph = resolveTypeVisual({ assetType: "AnimationGraph" });
    const component = resolveTypeVisual({
      classId: "AnimationGraphComponent",
    });
    expect(animation.icon).toBe(FilmIcon);
    expect(graph.icon).toBe(WorkflowIcon);
    expect(graph.icon).not.toBe(animation.icon);
    expect(component.icon).toBe(WorkflowIcon);
  });

  it("gives BehaviourTree a list-tree glyph distinct from Film", () => {
    const tree = resolveTypeVisual({ assetType: "BehaviourTree" });
    const component = resolveTypeVisual({
      classId: "BehaviourTreeComponent",
    });
    expect(tree.icon).toBe(ListTreeIcon);
    expect(tree.colorVar).toBe("var(--asset-animation)");
    expect(tree.icon).not.toBe(FilmIcon);
    expect(component.icon).toBe(ListTreeIcon);
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
    ).toBe("var(--asset-animation)");
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
    expect(visual.colorVar).toBe("var(--asset-animation)");
  });

  it("uses the component icon with Actor color for engine Actor placeholders", () => {
    const boxed = resolveActorTypeVisual({
      classId: "Actor",
      components: [{ classId: "MeshComponent" }],
    });
    expect(boxed.icon).toBe(
      resolveTypeVisual({ classId: "MeshComponent" }).icon,
    );
    expect(boxed.colorVar).toBe("var(--asset-animation)");
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
    expect(glyph.getAttribute("stroke")).toBe("var(--asset-scene)");
  });

  it("rasterizes chrome glyphs at 16px with Lucide fill none", () => {
    const visual = resolveTypeVisual({ assetType: "Scene" });
    const { getByTestId } = render(
      <TypeVisualIcon visual={visual} data-testid="glyph" />,
    );
    const glyph = getByTestId("glyph");
    expect(glyph.tagName.toLowerCase()).toBe("svg");
    expect(glyph.getAttribute("width")).toBe(String(TYPE_VISUAL_ICON_CHROME_SIZE));
    expect(glyph.getAttribute("height")).toBe(String(TYPE_VISUAL_ICON_CHROME_SIZE));
    expect(glyph.getAttribute("fill")).toBe("none");
    expect(glyph.getAttribute("stroke-width")).toBe("2");
    expect(glyph.getAttribute("class") ?? "").toContain("size-4");
    expect(glyph.getAttribute("class") ?? "").toContain("overflow-visible");
  });

  it("keeps tile glyph stroke at 2 CSS px via Lucide absoluteStrokeWidth", () => {
    const visual = resolveTypeVisual({ assetType: "Texture" });
    const { getByTestId } = render(
      <TypeVisualIcon
        visual={visual}
        size={TYPE_VISUAL_ICON_TILE_SIZE}
        data-testid="glyph"
      />,
    );
    const glyph = getByTestId("glyph");
    expect(glyph.getAttribute("width")).toBe(String(TYPE_VISUAL_ICON_TILE_SIZE));
    expect(glyph.getAttribute("height")).toBe(String(TYPE_VISUAL_ICON_TILE_SIZE));
    expect(glyph.getAttribute("stroke-width")).toBe(
      String((2 * 24) / TYPE_VISUAL_ICON_TILE_SIZE),
    );
    expect(glyph.getAttribute("class") ?? "").toContain("size-10");
  });
});
