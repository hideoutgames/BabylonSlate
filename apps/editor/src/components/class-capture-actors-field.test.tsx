import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createActor, type SerializedScene } from "@haptic/core";
import { ClassCaptureActorsField } from "./class-capture-actors-field";

const harness = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => harness.value),
);

function scene(...actors: Array<[string, string]>): SerializedScene {
  return { actors: actors.map(([id, name]) => createActor(id, name)) } as SerializedScene;
}

function openScene(path: string, content: SerializedScene) {
  return { id: `scene:${path}`, ref: { kind: "scene", path, label: path }, content, layout: null, dirty: false };
}

const REGISTRY = {
  list: () => [
    { path: "scenes/Alpha.scene.hasset", header: { type: "Scene", name: "Alpha", guid: "scene-alpha" } },
    { path: "scenes/Beta.scene.hasset", header: { type: "Scene", name: "Beta", guid: "scene-beta" } },
    { path: "scenes/Gamma.scene.hasset", header: { type: "Scene", name: "Gamma", guid: "scene-gamma" } },
    { path: "classes/Camera.class.hasset", header: { type: "Class", name: "Camera", guid: "class-camera" } },
  ],
};
const CLASS_TAB = {
  id: "graph:classes/Camera.class.hasset",
  ref: { kind: "graph", path: "classes/Camera.class.hasset", label: "Camera" },
  content: { nodes: [], edges: [] }, layout: null, dirty: false,
};
const ALPHA = openScene("scenes/Alpha.scene.hasset", scene(["hero", "Hero"]));
const BETA = openScene("scenes/Beta.scene.hasset", scene(["wall", "Wall"]));

function renderField(options: { openDocuments: unknown[]; activeDocumentId: string; saved?: Record<string, SerializedScene> }) {
  const loadAssetDocument = vi.fn(async (_kind: string, path: string) => options.saved?.[path] ?? null);
  harness.value = { assetRegistry: REGISTRY, openDocuments: options.openDocuments, activeDocumentId: options.activeDocumentId, loadAssetDocument };
  let stored: string[] = [];
  function Harness() {
    const [actorIds, setActorIds] = useState<string[]>([]);
    stored = actorIds;
    return <ClassCaptureActorsField actorIds={actorIds} onChange={setActorIds} />;
  }
  render(<Harness />);
  return { loadAssetDocument, stored: () => stored };
}

async function actorOptions(): Promise<string[]> {
  fireEvent.click(screen.getByRole("button", { name: "Add Actor" }));
  const picker = await screen.findByTestId("capture-actors-picker");
  const names = within(picker).queryAllByRole("option").map((option) => option.textContent ?? "");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return names;
}

async function pickScene(name: string) {
  fireEvent.click(screen.getByTestId("property-capture-source-scene"));
  const picker = await screen.findByTestId("capture-source-scene-picker");
  fireEvent.click(within(picker).getByRole("option", { name: new RegExp(`^${name}`) }));
}

afterEach(() => {
  cleanup();
  harness.value = {};
});

describe("Class Render Target Capture actors", () => {
  it.each([
    { active: BETA.id, scene: "Beta", actor: "Wall", other: "Hero" },
    { active: CLASS_TAB.id, scene: "Alpha", actor: "Hero", other: "Wall" },
  ])("defaults to the active Scene tab, else the first open Scene ($scene)", async ({ active, scene: sceneName, actor, other }) => {
    renderField({ openDocuments: [CLASS_TAB, ALPHA, BETA], activeDocumentId: active });
    expect(screen.getByTestId("property-capture-source-scene").textContent).toContain(sceneName);
    const names = await actorOptions();
    expect(names.some((name) => name.includes(actor))).toBe(true);
    expect(names.some((name) => name.includes(other))).toBe(false);
  });

  it("lists and stores actors from the Scene chosen in the picker", async () => {
    const field = renderField({ openDocuments: [CLASS_TAB, ALPHA, BETA], activeDocumentId: BETA.id });
    await pickScene("Alpha");
    expect(screen.getByTestId("property-capture-source-scene").textContent).toContain("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add Actor" }));
    fireEvent.click(await screen.findByRole("option", { name: /Hero/ }));
    expect(field.stored()).toEqual(["hero"]);
    expect(screen.getByTestId("capture-actors-field").textContent).toContain("Hero");
  });

  it("reads a Scene that is not open when no Scene tab is open", async () => {
    const field = renderField({
      openDocuments: [CLASS_TAB], activeDocumentId: CLASS_TAB.id,
      saved: { "scenes/Gamma.scene.hasset": scene(["crate", "Crate"]) },
    });
    expect(screen.getByTestId("property-capture-source-scene").textContent).toContain("None");
    expect(await actorOptions()).toEqual([]);
    await pickScene("Gamma");
    expect(field.loadAssetDocument).toHaveBeenCalledWith("scene", "scenes/Gamma.scene.hasset");
    fireEvent.click(screen.getByRole("button", { name: "Add Actor" }));
    fireEvent.click(await screen.findByRole("option", { name: /Crate/ }));
    expect(field.stored()).toEqual(["crate"]);
  });
});
