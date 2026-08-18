import { describe, expect, it } from "vitest";
import {
  classHeaderMeta,
  functionLibraryHeaderMeta,
  isEditorFunctionLibraryClass,
  isEditorGraphClass,
  isEditorGraphHost,
  isEditorOnlyAsset,
  isEditorOnlyAssetType,
  isEditorUtilityObjectClass,
  isFunctionLibraryClass,
  normalizeEditorUtilityDockKind,
  editorUtilityDockKindLabel,
} from "./editor-only";

describe("editor-only assets", () => {
  const parentOf = (id: string) => {
    if (id === "LevelTools") return "EditorUtilityObject";
    if (id === "EditorUtilityObject") return "BObject";
    if (id === "Hero") return "Actor";
    if (id === "MathLib") return "FunctionLibrary";
    if (id === "FunctionLibrary") return "BObject";
    if (id === "EditorMath") return "EditorFunctionLibrary";
    if (id === "EditorFunctionLibrary") return "FunctionLibrary";
    return null;
  };

  it("treats EditorUtilityInterface as editor-only", () => {
    expect(isEditorOnlyAssetType("EditorUtilityInterface")).toBe(true);
    expect(isEditorOnlyAssetType("PluginSettings")).toBe(true);
    expect(isEditorOnlyAssetType("SkyboxCreator")).toBe(true);
    expect(isEditorOnlyAssetType("UserInterface")).toBe(false);
    expect(isEditorOnlyAssetType("Texture")).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "EditorUtilityInterface", parentClass: null },
        parentOf,
      ),
    ).toBe(true);
  });

  it("walks the EditorUtilityObject parent chain on Class assets", () => {
    expect(isEditorUtilityObjectClass("LevelTools", parentOf)).toBe(true);
    expect(isEditorUtilityObjectClass("Hero", parentOf)).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "Class", parentClass: "LevelTools" },
        parentOf,
      ),
    ).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Class", parentClass: "Actor" }, parentOf),
    ).toBe(false);
  });

  it("normalizes EditorUtilityInterface dockKind to Dockview document kinds", () => {
    expect(normalizeEditorUtilityDockKind("class")).toBe("graph");
    expect(normalizeEditorUtilityDockKind("graph")).toBe("graph");
    expect(normalizeEditorUtilityDockKind("scene")).toBe("scene");
    expect(normalizeEditorUtilityDockKind("sprite")).toBe("sprite");
    expect(normalizeEditorUtilityDockKind("tilemap")).toBe("tilemap");
    expect(normalizeEditorUtilityDockKind("skybox-creator")).toBe(
      "skybox-creator",
    );
    expect(editorUtilityDockKindLabel("skybox-creator")).toBe("Skybox Creator");
    expect(normalizeEditorUtilityDockKind(undefined)).toBe("scene");
    expect(normalizeEditorUtilityDockKind("viewport")).toBe("scene");
    expect(editorUtilityDockKindLabel("graph")).toBe("Class");
    expect(editorUtilityDockKindLabel("sprite-animation")).toBe("Sprite Animation");
  });

  it("does not treat FunctionLibrary ancestry as editor-only", () => {
    expect(isEditorFunctionLibraryClass("MathLib", parentOf)).toBe(false);
    expect(
      isEditorOnlyAsset({ type: "Class", parentClass: "MathLib" }, parentOf),
    ).toBe(false);
  });

  it("treats EditorFunctionLibrary ancestry as editor-only on Class and Graph assets", () => {
    expect(isEditorFunctionLibraryClass("EditorMath", parentOf)).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Class", parentClass: "EditorMath" }, parentOf),
    ).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Graph", parentClass: "EditorMath" }, parentOf),
    ).toBe(true);
  });

  it("detects editor graph hosts from asset type, parent class, and editorGraph", () => {
    expect(isEditorGraphHost({ assetType: "UserInterface" })).toBe(false);
    expect(isEditorGraphHost({ assetType: "EditorUtilityInterface" })).toBe(
      true,
    );
    expect(
      isEditorGraphHost({ parentClass: "EditorUtilityObject", parentOf }),
    ).toBe(true);
    expect(isEditorGraphHost({ editorGraph: true })).toBe(true);
    expect(isEditorGraphClass("LevelTools", parentOf)).toBe(true);
    expect(isEditorGraphClass("EditorMath", parentOf)).toBe(true);
    expect(isEditorGraphClass("Hero", parentOf)).toBe(false);
  });

  it("treats EditorFunctionLibrary as a FunctionLibrary", () => {
    expect(isFunctionLibraryClass("EditorFunctionLibrary", parentOf)).toBe(
      true,
    );
    expect(isFunctionLibraryClass("MathLib", parentOf)).toBe(true);
    expect(isFunctionLibraryClass("Hero", parentOf)).toBe(false);
  });

  it("indexes only function members for a FunctionLibrary header", () => {
    expect(
      functionLibraryHeaderMeta({
        members: [
          {
            kind: "function",
            name: "Add",
            pins: [{ name: "a", typeId: "float", direction: "in" }],
          },
          { kind: "variable", name: "X" },
          { kind: "event", name: "On Hit" },
          { kind: "function", name: "Scale" },
        ],
      }),
    ).toEqual({
      functions: [
        {
          name: "Add",
          pins: [{ name: "a", typeId: "float", direction: "in" }],
        },
        { name: "Scale", pins: [] },
      ],
    });
  });

  it("indexes class variables, functions, and events with typeClassId for closed assets", () => {
    expect(
      classHeaderMeta({
        members: [
          {
            id: "var-1",
            kind: "variable",
            name: "Target",
            typeId: "object",
            typeClassId: "Hero",
          },
          {
            id: "var-local",
            kind: "variable",
            name: "Temp",
            typeId: "float",
            functionId: "fn-1",
          },
          {
            id: "fn-1",
            kind: "function",
            name: "Possess",
            overridable: true,
            pins: [
              {
                name: "pawn",
                typeId: "object",
                direction: "in",
                typeClassId: "Pawn",
              },
            ],
          },
          {
            id: "ev-1",
            kind: "event",
            name: "On Hit",
            pins: [
              {
                name: "other",
                typeId: "object",
                direction: "out",
                typeClassId: "Actor",
              },
            ],
          },
          { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "g1" },
        ],
      }),
    ).toEqual({
      functions: [
        {
          id: "fn-1",
          name: "Possess",
          overridable: true,
          pins: [
            {
              name: "pawn",
              typeId: "object",
              direction: "in",
              typeClassId: "Pawn",
            },
          ],
        },
      ],
      variables: [
        {
          id: "var-1",
          name: "Target",
          typeId: "object",
          typeClassId: "Hero",
        },
      ],
      events: [
        {
          id: "ev-1",
          name: "On Hit",
          pins: [
            {
              name: "other",
              typeId: "object",
              direction: "out",
              typeClassId: "Actor",
            },
          ],
        },
      ],
      interfaces: [
        { id: "if-1", name: "Damageable", assetGuid: "g1" },
      ],
      components: [],
    });
  });

  it("indexes prefab components on Class headers", () => {
    expect(
      classHeaderMeta({
        members: [],
        components: [
          {
            id: "mesh-1",
            classId: "MeshComponent",
            parentId: null,
            properties: { meshKind: "box" },
          },
        ],
      }),
    ).toEqual({
      functions: [],
      variables: [],
      events: [],
      interfaces: [],
      components: [
        {
          id: "mesh-1",
          classId: "MeshComponent",
          parentId: null,
          properties: { meshKind: "box" },
        },
      ],
    });
  });
});
