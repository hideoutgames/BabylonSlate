import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ENGINE_COMPONENT_CLASS_IDS } from "@babylonslate/core";
import {
  CloudIcon,
  FileBoxIcon,
  FileAxis3dIcon,
  FileBracesCornerIcon,
  FileCogIcon,
  FileIcon,
  FileSlidersIcon,
  FileSpreadsheetIcon,
  FileStackIcon,
  FileTerminalIcon,
  LightbulbIcon,
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
  it("recognizes Material Object references as objects with the material glyph", () => {
    expect(walkAncestry("MaterialObject", engineParentOf)).toEqual(["MaterialObject", "BObject"]);
    const visual = resolveTypeVisual({ classId: "MaterialObject" });
    expect(visual.family).toBe("class");
    expect(visual.icon).toBe(resolveTypeVisual({ assetType: "Material" }).icon);
  });

  it("walks subsystem bases through the hidden Subsystem base to BObject", () => {
    expect(walkAncestry("GameSubsystem", engineParentOf)).toEqual([
      "GameSubsystem",
      "Subsystem",
      "BObject",
    ]);
    expect(walkAncestry("SceneSubsystem", engineParentOf)).toEqual([
      "SceneSubsystem",
      "Subsystem",
      "BObject",
    ]);
  });

  it.each([
    ["BObject", FileIcon],
    ["Actor", FileBoxIcon],
    ["GameInstance", FileSlidersIcon],
    ["GameSubsystem", FileStackIcon],
    ["SceneSubsystem", FileAxis3dIcon],
    ["FunctionLibrary", FileSpreadsheetIcon],
    ["ActorComponent", FileCogIcon],
    ["BDebugCommand", FileTerminalIcon],
    ["EditorUtilityObject", FileBracesCornerIcon],
    ["EditorFunctionLibrary", FileSpreadsheetIcon],
  ] as const)("uses the %s class glyph for its user-authored subclasses", (parentClass, icon) => {
    const visual = resolveTypeVisual({
      assetType: "Class",
      classId: "CustomClass",
      ancestry: ["CustomClass", parentClass, "BObject"],
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
    expect(fill.icon).toBe(LightbulbIcon);
    expect(engineParentOf("HemisphericFillLightComponent")).toBe("ActorComponent");
    const outline = resolveTypeVisual({ classId: "OutlineComponent" });
    expect(outline.icon).toBe(SquareDashedIcon);
    expect(outline.colorVar).toBe(mesh.colorVar);
    expect(engineParentOf("OutlineComponent")).toBe("ActorComponent");
    const skybox = resolveTypeVisual({ classId: "SkyboxComponent" });
    expect(skybox.iconKey).toBe("SkyboxComponent");
    expect(skybox.icon).toBe(CloudIcon);
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
});
