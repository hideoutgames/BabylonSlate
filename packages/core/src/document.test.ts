import { describe, expect, it } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
  createEmptyLayouts,
  documentId,
  isClosableDocumentKind,
  isContentBrowserId,
  labelFromPath,
  migrateLegacyLayout,
} from "./document";
import { createDefaultScene } from "./project";

describe("documentId", () => {
  it("uses a stable id for the pinned Content Browser", () => {
    expect(documentId(CONTENT_BROWSER_REF)).toBe(CONTENT_BROWSER_ID);
    expect(isContentBrowserId(CONTENT_BROWSER_ID)).toBe(true);
    expect(isContentBrowserId("scene:assets/main.scene.babasset")).toBe(false);
  });

  it("namespaces scene and graph ids by path", () => {
    expect(
      documentId({ kind: "scene", path: "assets/main.scene.babasset" }),
    ).toBe("scene:assets/main.scene.babasset");
    expect(
      documentId({ kind: "graph", path: "assets/main.graph.babasset" }),
    ).toBe("graph:assets/main.graph.babasset");
  });
});

describe("isClosableDocumentKind", () => {
  it("keeps the Content Browser pinned while scenes and graphs close", () => {
    expect(isClosableDocumentKind("content-browser")).toBe(false);
    expect(isClosableDocumentKind("scene")).toBe(true);
    expect(isClosableDocumentKind("graph")).toBe(true);
  });
});

describe("labelFromPath / createDocumentRef", () => {
  it("title-cases the basename and strips container suffixes", () => {
    expect(labelFromPath("assets/my-cool_level.scene.babasset")).toBe(
      "My Cool Level",
    );
    expect(labelFromPath("assets/player_ai.graph.json")).toBe("Player Ai");
  });

  it("labels scenes from content name and graphs from the path", () => {
    const scene = { ...createDefaultScene(), name: "Boss Arena" };
    expect(
      createDocumentRef("scene", "assets/boss.scene.babasset", scene),
    ).toEqual({
      kind: "scene",
      path: "assets/boss.scene.babasset",
      label: "Boss Arena Scene",
    });
    expect(createDocumentRef("graph", "assets/ai_tree.graph.babasset")).toEqual(
      {
        kind: "graph",
        path: "assets/ai_tree.graph.babasset",
        label: "Ai Tree Graph",
      },
    );
  });
});

describe("layouts", () => {
  it("starts empty and wraps a legacy dock layout under the main scene", () => {
    expect(createEmptyLayouts()).toEqual({
      documents: {},
      tabOrder: [],
      activeDocumentId: null,
    });
    const legacy = { grid: { root: "viewport" } };
    expect(migrateLegacyLayout(legacy, "scene:main")).toEqual({
      documents: { "scene:main": legacy },
      tabOrder: ["scene:main"],
      activeDocumentId: "scene:main",
    });
  });
});
