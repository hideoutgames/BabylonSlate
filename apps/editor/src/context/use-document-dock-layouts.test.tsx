import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DockviewReact, type DockviewApi, type IDockviewPanelProps } from "dockview-react";
import { createDefaultScene } from "@haptic/core";
import { engineSettingsSchema, type createAppSettingsStore } from "@haptic/vfs";
import { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import { useDocumentDockLayouts } from "./use-document-dock-layouts";

// Focus closes the windows it does not keep and leaving it restores the layout from before. The Viewport is open in
// both layouts: its React content owns the scene's canvas and engine, so remounting it reloads the scene and drops a
// running Simulation's view. Leaving Focus must keep it mounted.

const project = {
  loadDocument: async () => createDefaultScene(),
  registry: null,
  registryGeneration: 0,
} as unknown as ProjectService;

const settingsStore = {
  load: async () => engineSettingsSchema.parse({ focusKeepPanels: { scene: ["viewport"] } }),
} as unknown as ReturnType<typeof createAppSettingsStore>;

afterEach(cleanup);

async function mountSceneDock() {
  const documentService = new DocumentService();
  const id = await documentService.openDocument(project, { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" });
  const lifecycle: string[] = [];
  function Window({ api }: IDockviewPanelProps) {
    const panelId = api.id;
    useEffect(() => {
      lifecycle.push(`mount ${panelId}`);
      return () => { lifecycle.push(`unmount ${panelId}`); };
    }, [panelId]);
    return <div data-testid={`window:${panelId}`} />;
  }
  let layouts!: ReturnType<typeof useDocumentDockLayouts>;
  let dock!: DockviewApi;
  function Harness() {
    layouts = useDocumentDockLayouts({ documentService, projectService: project, settingsStore, bump: () => {} });
    return (
      <DockviewReact
        components={{ window: Window }}
        onReady={({ api }) => {
          dock = api;
          api.layout(1200, 800);
          api.addPanel({ id: "viewport", component: "window", title: "Viewport" });
          api.addPanel({ id: "scene-outliner", component: "window", title: "Outliner", position: { referencePanel: "viewport", direction: "left" } });
          api.addPanel({ id: "scene-details", component: "window", title: "Details", position: { referencePanel: "viewport", direction: "right" } });
          layouts.registerDockviewApi(id, api, "design");
        }}
      />
    );
  }
  render(<Harness />);
  return { lifecycle, toggleFocus: () => act(() => layouts.toggleLayoutFocus()), dock: () => dock };
}

describe("Focus layout", () => {
  it("keeps the Viewport mounted when Focus is entered and left", async () => {
    const { lifecycle, toggleFocus, dock } = await mountSceneDock();
    const viewportElement = screen.getByTestId("window:viewport");
    const viewportPanel = dock().getPanel("viewport");
    lifecycle.length = 0;

    await toggleFocus();
    expect(dock().panels.map((panel) => panel.id)).toEqual(["viewport"]);
    expect(lifecycle).toEqual(["unmount scene-outliner", "unmount scene-details"]);

    lifecycle.length = 0;
    await toggleFocus();
    expect(dock().panels.map((panel) => panel.id).sort()).toEqual(["scene-details", "scene-outliner", "viewport"]);
    expect(lifecycle.sort()).toEqual(["mount scene-details", "mount scene-outliner"]);
    expect(dock().getPanel("viewport")).toBe(viewportPanel);
    expect(screen.getByTestId("window:viewport")).toBe(viewportElement);
  });
});
