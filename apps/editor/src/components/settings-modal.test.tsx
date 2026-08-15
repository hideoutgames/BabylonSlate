import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsModal } from "./settings-modal";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const { updateProjectSettings } = vi.hoisted(() => ({
  updateProjectSettings: vi.fn(),
}));

vi.mock("../context/document-context", async () => {
  const { createEmptyProject: emptyProject } = await import("@babylonslate/core");
  return {
    useDocuments: () => ({
      projectDocument: emptyProject("Demo"),
      exportProject: vi.fn(),
      retryFailedTextureEncoding: vi.fn(),
      updateProjectSettings,
      assetRegistry: {
        list: () => [
          {
            header: { guid: "font-1", name: "Display", type: "Font" },
            path: "assets/Display.font.babasset",
          },
          {
            header: { guid: "scene-1", name: "Main", type: "Scene" },
            path: "assets/main.scene.babasset",
          },
          {
            header: { guid: "scene-2", name: "Arena", type: "Scene" },
            path: "assets/Arena.scene.babasset",
          },
          {
            header: {
              guid: "class-tools",
              name: "Tools",
              type: "Class",
              parentClass: "EditorUtilityObject",
            },
            path: "assets/Tools.class.babasset",
          },
        ],
        getByGuid: (guid: string) =>
          guid === "font-1"
            ? {
                header: { guid: "font-1", name: "Display", type: "Font" },
                path: "assets/Display.font.babasset",
              }
            : undefined,
      },
      openDocuments: [],
      pluginDescriptors: [],
      pluginDiagnostics: [],
      applyPluginOverrides: vi.fn(),
      createProjectPlugin: vi.fn(),
      deleteProjectPlugin: vi.fn(),
      openDocument: vi.fn(),
    }),
  };
});

afterEach(() => {
  cleanup();
  updateProjectSettings.mockClear();
});

describe("SettingsModal project authoring", () => {
  it("edits input mappings with the structured editor instead of JSON", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-input"));
    expect(screen.getByTestId("settings-input-mapping")).toBeTruthy();
    expect(screen.queryByTestId("settings-input-actions")).toBeNull();
    expect(screen.getByTestId("input-action-0-name")).toBeTruthy();
    fireEvent.click(screen.getByTestId("input-action-add"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ name: "New Action" }),
          ]),
        }),
      }),
    );
  });

  it("picks the default font from Font assets instead of a guid field", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-fonts"));
    expect(screen.queryByTestId("settings-default-font-guid")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-default-font"));
    expect(await screen.findByTestId("search-item-font-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-font-1"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        fonts: expect.objectContaining({ defaultFontGuid: "font-1" }),
      }),
    );
  });

  it("edits sorting layers as a named list", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-twoD"));
    fireEvent.change(screen.getByTestId("settings-sorting-layers-0-value"), {
      target: { value: "Far" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        twoD: expect.objectContaining({
          sortingLayers: expect.arrayContaining(["Far"]),
        }),
      }),
    );
  });

  it("picks the packaged startup scene from Scene assets only", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("settings-startup-scene"));
    expect(await screen.findByTestId("search-item-scene-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-font-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-scene-2"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ startupSceneGuid: "scene-2" }),
    );
  });

  it("authors custom render resolution on the Rendering category", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByTestId("setting-render-custom")).toBeTruthy();
    expect(screen.getByTestId("setting-render-width")).toBeTruthy();
    expect(screen.getByTestId("setting-render-height")).toBeTruthy();
    expect(screen.getByTestId("setting-render-black-bars")).toBeTruthy();
  });

  it("registers EditorUtilityObject classes from a ClassPicker list", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-general"));
    fireEvent.click(screen.getByTestId("settings-editor-utility-objects-add"));
    expect(await screen.findByTestId("search-item-Tools")).toBeTruthy();
    expect(screen.queryByTestId("search-item-Hero")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-Tools"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        editorUtilityObjects: ["Tools"],
      }),
    );
  });

  it("opens a Plugins category for enablement and New Plugin", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    expect(screen.getByTestId("settings-plugins-panel")).toBeTruthy();
    expect(screen.getByTestId("settings-plugin-new")).toBeTruthy();
  });
});
