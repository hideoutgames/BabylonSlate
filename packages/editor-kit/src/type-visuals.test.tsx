import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ENGINE_COMPONENT_CLASS_IDS } from "@haptic/core";
import { EqualizerIcon } from "@phosphor-icons/react/dist/csr/Equalizer";
import {
  CloudSunIcon,
  FileBoxIcon,
  FileAxis3dIcon,
  FileBracesCornerIcon,
  FileCogIcon,
  FileIcon,
  FileSlidersIcon,
  FileSpreadsheetIcon,
  FileStackIcon,
  FileTerminalIcon,
  HazeIcon,
  SparklesIcon,
  SquareDashedIcon,
  TypeIcon,
} from "lucide-react";
import {
  TypeVisualIcon,
  engineParentOf,
  resolveActorTypeVisual,
  resolveTypeVisual,
  walkAncestry,
} from "./type-visuals";

describe("resolveTypeVisual", () => {
  it("gives Timeline assets their own glyph, apart from the animation assets'", () => {
    const timeline = resolveTypeVisual({ assetType: "Timeline" });
    expect(timeline.family).toBe("animation");
    for (const assetType of ["SpriteAnimation", "Animation"]) expect(resolveTypeVisual({ assetType }).icon).not.toBe(timeline.icon);
  });

  it("colours Textures with Class's blue, apart from render targets, Camera Shakes and the 2D assets", () => {
    expect(resolveTypeVisual({ assetType: "Texture" }).colorVar).toBe(resolveTypeVisual({ assetType: "Class" }).colorVar);
    for (const assetType of ["RenderTarget", "RenderTargetTexture", "CameraShake"]) expect(resolveTypeVisual({ assetType }).colorVar).toBe("var(--asset-render-target)");
    for (const assetType of ["Sprite", "SpriteAnimation", "AnimationGraph2D", "Tileset", "Tilemap"]) expect(resolveTypeVisual({ assetType }).colorVar).toBe("var(--asset-sprite)");
  });

  it("gives particle assets the Visual Effects colour and Material Instances their own, apart from Materials", () => {
    for (const assetType of ["ParticleEmitter", "ParticleGraph", "ParticleSystem"]) {
      expect(resolveTypeVisual({ assetType }).colorVar, assetType).toBe("var(--asset-visual-effects)");
    }
    expect(resolveTypeVisual({ assetType: "MaterialInstance" }).colorVar).toBe("var(--asset-material-instance)");
    for (const assetType of ["Material", "MaterialFunction", "Water", "SkyboxCreator"]) {
      expect(resolveTypeVisual({ assetType }).colorVar, assetType).toBe("var(--asset-material)");
    }
  });

  it("recognizes Material Object references as objects with the material glyph", () => {
    expect(walkAncestry("MaterialObject", engineParentOf)).toEqual(["MaterialObject", "Object"]);
    const visual = resolveTypeVisual({ classId: "MaterialObject" });
    expect(visual.family).toBe("class");
    expect(visual.icon).toBe(resolveTypeVisual({ assetType: "Material" }).icon);
  });

  it("walks subsystem bases through the hidden Subsystem base to Object", () => {
    expect(walkAncestry("GameSubsystem", engineParentOf)).toEqual([
      "GameSubsystem",
      "Subsystem",
      "Object",
    ]);
    expect(walkAncestry("SceneSubsystem", engineParentOf)).toEqual([
      "SceneSubsystem",
      "Subsystem",
      "Object",
    ]);
  });

  it.each([
    ["Object", FileIcon],
    ["Actor", FileBoxIcon],
    ["GameInstance", FileSlidersIcon],
    ["GameSubsystem", FileStackIcon],
    ["SceneSubsystem", FileAxis3dIcon],
    ["FunctionLibrary", FileSpreadsheetIcon],
    ["ActorComponent", FileCogIcon],
    ["DebugCommand", FileTerminalIcon],
    ["EditorUtilityObject", FileBracesCornerIcon],
    ["EditorFunctionLibrary", FileSpreadsheetIcon],
  ] as const)("uses the %s class glyph for its user-authored subclasses", (parentClass, icon) => {
    const visual = resolveTypeVisual({
      assetType: "Class",
      classId: "CustomClass",
      ancestry: ["CustomClass", parentClass, "Object"],
    });
    expect(visual.icon).toBe(icon);
    expect(visual.colorVar).toBe("var(--asset-animation)");
  });

  it("uses Class color and the parent icon for Class assets", () => {
    const actorClass = resolveTypeVisual({
      assetType: "Class",
      parentClass: "Actor",
    });
    expect(actorClass.colorVar).toBe("var(--asset-animation)");
    expect(actorClass.icon).toBe(resolveTypeVisual({ classId: "Actor" }).icon);
  });

  it.each(["MeshComponent", "SplineComponent"])("keeps the Class color and nearest engine icon on attached custom %s subclasses", (classId) => {
    const component = resolveTypeVisual({ classId });
    const userComponent = resolveTypeVisual({
      classId: "CustomComponent",
      ancestry: ["CustomComponent", ...walkAncestry(classId, engineParentOf)],
    });
    expect(userComponent.colorVar).toBe("var(--asset-animation)");
    expect(component.colorVar).toBe("var(--asset-component)");
    expect(userComponent.icon).toBe(component.icon);
    expect(userComponent.icon).not.toBe(
      resolveTypeVisual({ classId: "ActorComponent" }).icon,
    );
  });

  it("resolves every engine component to component chrome with a dedicated glyph", () => {
    for (const classId of ENGINE_COMPONENT_CLASS_IDS) {
      const visual = resolveTypeVisual({ classId });
      expect(visual.family, classId).toBe("component");
      expect(visual.iconKey, classId).toBe(classId);
      expect(visual.icon, classId).not.toBe(FileIcon);
    }
  });

  it("uses component color for engine components unless family is overridden", () => {
    const mesh = resolveTypeVisual({ classId: "MeshComponent" });
    const light = resolveTypeVisual({ classId: "LightComponent" });
    expect(mesh.family).toBe("component");
    expect(mesh.colorVar).toBe("var(--asset-component)");
    expect(light.colorVar).toBe(mesh.colorVar);
    expect(light.icon).not.toBe(mesh.icon);
    const fill = resolveTypeVisual({ classId: "HemisphericFillLightComponent" });
    expect(fill.iconKey).toBe("HemisphericFillLightComponent");
    expect(fill.icon).toBe(HazeIcon);
    expect(engineParentOf("HemisphericFillLightComponent")).toBe("ActorComponent");
    const outline = resolveTypeVisual({ classId: "OutlineComponent" });
    expect(outline.icon).toBe(SquareDashedIcon);
    expect(outline.colorVar).toBe(mesh.colorVar);
    expect(engineParentOf("OutlineComponent")).toBe("ActorComponent");
    const skybox = resolveTypeVisual({ classId: "SkyboxComponent" });
    expect(skybox.iconKey).toBe("SkyboxComponent");
    expect(skybox.icon).toBe(CloudSunIcon);
    expect(skybox.colorVar).toBe(mesh.colorVar);
    const text3d = resolveTypeVisual({ classId: "Text3DComponent" });
    expect(text3d.iconKey).toBe("Text3DComponent");
    expect(text3d.icon).toBe(TypeIcon);
    expect(text3d.colorVar).toBe(mesh.colorVar);
    expect(engineParentOf("Text3DComponent")).toBe("ActorComponent");
    expect(engineParentOf("2DTextComponent")).toBe("ActorComponent");
    expect(engineParentOf("2DRichTextComponent")).toBe("ActorComponent");
    const text2d = resolveTypeVisual({ classId: "2DTextComponent" });
    expect(text2d.iconKey).toBe("2DTextComponent");
    expect(text2d.icon).toBe(TypeIcon);
    const rich = resolveTypeVisual({ classId: "2DRichTextComponent" });
    expect(rich.iconKey).toBe("2DRichTextComponent");
    expect(rich.icon).toBe(SparklesIcon);
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

describe("Class kind labels", () => {
  it.each([
    [["MyHero", "Actor", "Object"], "Actor"],
    [["MyLayerActor", "SceneLayerActor", "Actor", "Object"], "Actor"],
    [["Inventory", "GameSubsystem", "Subsystem", "Object"], "Subsystem"],
    [["Weather", "SceneSubsystem", "Subsystem", "Object"], "Subsystem"],
    [["MyGame", "GameInstance", "Object"], "Game Instance"],
    [["Health", "ActorComponent", "Object"], "Component"],
    [["MathHelpers", "FunctionLibrary", "Object"], "Function Library"],
    [["Tools", "EditorFunctionLibrary", "FunctionLibrary", "Object"], "Editor Function Library"],
    [["Cheat", "DebugCommand", "Object"], "Debug Command"],
    [["Importer", "EditorUtilityObject", "Object"], "Editor Utility Object"],
    [["Patrol", "BTTask", "Object"], "Behaviour Tree Task"],
    [["IsHungry", "BTDecorator", "Object"], "Behaviour Tree Decorator"],
    [["Scan", "BTService", "Object"], "Behaviour Tree Service"],
    [["Random", "BTComposite", "Object"], "Behaviour Tree Composite"],
    [["Bounce", "RichText2DAppearMode", "Object"], "Rich Text Appear Mode"],
    [["Wobble", "RichText2DDecoratorEffect", "Object"], "Rich Text Decorator Effect"],
    [["Snap", "CustomEasingCurve", "Object"], "Easing Curve"],
    [["Snappier", "Snap", "CustomEasingCurve", "Object"], "Easing Curve"],
    [["GameRules", "Object"], "Object"],
    [["Orphan"], "Object"],
  ] as const)("labels a Class with ancestry %j as %s", (ancestry, label) => {
    expect(resolveTypeVisual({ assetType: "Class", ancestry: [...ancestry] }).classKind).toBe(label);
  });

  it("walks engine parents when only the parent class is known, and labels only Class assets", () => {
    expect(resolveTypeVisual({ assetType: "Class", parentClass: "SceneStreamingActor" }).classKind).toBe("Actor");
    expect(resolveTypeVisual({ assetType: "Class" }).classKind).toBe("Object");
    expect(resolveTypeVisual({ assetType: "Texture" }).classKind).toBeUndefined();
    expect(resolveTypeVisual({ classId: "Actor" }).classKind).toBeUndefined();
  });
});

describe("walkAncestry", () => {
  it("walks parent links from most specific to root", () => {
    const parents = new Map<string, string | null>([
      ["MyHero", "HeroBase"],
      ["HeroBase", "Actor"],
      ["Actor", "Object"],
      ["Object", null],
    ]);
    expect(walkAncestry("MyHero", (id) => parents.get(id))).toEqual([
      "MyHero",
      "HeroBase",
      "Actor",
      "Object",
    ]);
  });
});

describe("resolveActorTypeVisual", () => {
  it("uses the Actor parent icon for user actor classes even when they have a mesh", () => {
    const visual = resolveActorTypeVisual({
      classId: "MyHero",
      ancestry: ["MyHero", "Actor", "Object"],
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

  it("draws Tabler glyphs in the asset colour with Lucide's stroke at list and tile size", () => {
    const strokeOf = (assetType: string, size?: number) => {
      const { getByTestId } = render(
        <TypeVisualIcon visual={resolveTypeVisual({ assetType })} size={size} data-testid="glyph" />,
      );
      const glyph = getByTestId("glyph");
      const stroke = { colour: glyph.getAttribute("stroke"), width: glyph.getAttribute("stroke-width"), icon: glyph.getAttribute("data-type-icon") };
      cleanup();
      return stroke;
    };
    // Model is Tabler, Class is Lucide.
    expect(strokeOf("Model")).toEqual({ colour: "var(--asset-model)", width: "2", icon: "Model" });
    expect(strokeOf("Model", 48).width).toBe(strokeOf("Class", 48).width);
    expect(strokeOf("Model", 48).width).toBe("1");
  });

  it("draws Phosphor glyphs in the asset colour, bold in chrome and light on tiles", () => {
    const pathsOf = (node: Element) => [...node.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|");
    const reference = (weight: "bold" | "light") => {
      const { container } = render(<EqualizerIcon weight={weight} />);
      const paths = pathsOf(container.querySelector("svg")!);
      cleanup();
      return paths;
    };
    const bold = reference("bold");
    const light = reference("light");
    const visual = resolveTypeVisual({ assetType: "AudioChannel" });

    const chrome = render(<TypeVisualIcon visual={visual} data-testid="glyph" />).getByTestId("glyph");
    expect(chrome.getAttribute("fill")).toBe(visual.colorVar);
    expect(chrome.getAttribute("data-type-icon")).toBe("AudioChannel");
    expect(pathsOf(chrome)).toBe(bold);
    cleanup();

    const tile = render(<TypeVisualIcon visual={visual} size={48} data-testid="glyph" />).getByTestId("glyph");
    expect(pathsOf(tile)).toBe(light);
  });
});
