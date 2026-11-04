import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createDefaultSceneSettings,
  DEFAULT_RENDER_EFFECTS,
  normalizeRenderProjectSettings,
  type ProjectDocument,
} from "@haptic/core";
import { humanizePropertyLabel } from "@haptic/editor-kit";
import {
  RENDERING_SETTINGS_SECTIONS,
  type RenderingProjectContext,
  type RenderingSceneContext,
} from "./rendering-settings-sections";

afterEach(cleanup);

const on = <T extends object>(group: T) => ({ ...group, enabled: true });
// Every optional row showing: CEL mode, manual local shadows and every effect on.
const renderSettings = normalizeRenderProjectSettings({
  mode: "cel",
  shadows: { enabled: true, localLightMode: "manual" },
  environmentLighting: { enabled: true },
  cel: { outlinesEnabled: true, outlineDistanceFadeEnabled: true, specularEnabled: true },
  effects: {
    ...DEFAULT_RENDER_EFFECTS,
    colorPipeline: { version: 1, mode: "sceneLinear" },
    whiteBalance: on(DEFAULT_RENDER_EFFECTS.whiteBalance),
    vignette: on(DEFAULT_RENDER_EFFECTS.vignette),
    bloom: on(DEFAULT_RENDER_EFFECTS.bloom),
    upscaling: on(DEFAULT_RENDER_EFFECTS.upscaling),
    colorGrading: on(DEFAULT_RENDER_EFFECTS.colorGrading),
    ambientOcclusion: on(DEFAULT_RENDER_EFFECTS.ambientOcclusion),
    reflections: on(DEFAULT_RENDER_EFFECTS.reflections),
    volumetricLighting: on(DEFAULT_RENDER_EFFECTS.volumetricLighting),
  },
});

const projectContext: RenderingProjectContext = {
  projectDocument: { settings: { render: renderSettings } } as ProjectDocument,
  render: renderSettings,
  setRender: () => {},
  updateProjectSettings: () => {},
  assetRegistry: null,
  setLutPickerOpen: () => {},
};

const sceneContext: RenderingSceneContext = {
  render: renderSettings,
  settings: createDefaultSceneSettings(),
  setSettings: () => {},
  environmentRows: <label>Environment Source</label>,
  lutControl: (control) => <button type="button" id={control.id}>None</button>,
  lutName: () => "None",
};

function labels(node: ReactNode): string[] {
  const { container, unmount } = render(<>{node}</>);
  const found = [...container.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "").filter(Boolean);
  unmount();
  return found;
}

const overridable = RENDERING_SETTINGS_SECTIONS.filter((section) => section.scene).map((section) => [section.title, section] as const);

it("lets a Scene override the Project Settings sections that carry scene overrides", () => {
  expect(overridable.map(([title]) => title)).toEqual(["Shadows", "Environment Lighting", "Post Processing", "CEL Shading"]);
});

it.each(overridable)("shows every %s field of Project Settings as a Scene override, in the same order", (_title, section) => {
  const project = labels(section.project(projectContext));
  const scene = labels(section.scene!.render(sceneContext));
  expect(project.length).toBeGreaterThan(3);
  // A Scene's own rows (Environment Source) may sit among them.
  expect(scene.filter((label) => project.includes(label))).toEqual(project);
});

it.each(overridable)("finds every %s field from the Scene Inspector's property filter", (_title, section) => {
  const searchable = humanizePropertyLabel(`${section.title} ${section.scene!.searchText}`).toLowerCase();
  // As the Inspector filters: the typed label and the searched text are both humanized.
  const missing = labels(section.project(projectContext)).filter((label) => !searchable.includes(humanizePropertyLabel(label).toLowerCase()));
  expect(missing).toEqual([]);
});
