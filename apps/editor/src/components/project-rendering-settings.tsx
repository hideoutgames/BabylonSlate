import type { ProjectDocument } from "@haptic/core";
import { FieldGroup } from "@haptic/ui/components/field";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { RENDERING_SETTINGS_SECTIONS, type RenderingProjectContext } from "./rendering-settings-sections";
import { SettingsSection } from "./settings-section";

interface ProjectRenderingSettingsProps {
  projectDocument: ProjectDocument;
  /** The host's wrapper: render, Play Frame Cap and Play Preview edits wait for Done. */
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setLutPickerOpen: (open: boolean) => void;
}

/** Project Settings → Rendering, not the Updating Rendering dialog. The host renders the LUT picker. */
export function ProjectRenderingSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  setLutPickerOpen,
}: ProjectRenderingSettingsProps) {
  const render = projectDocument.settings.render;
  const context: RenderingProjectContext = {
    projectDocument,
    render,
    setRender: (next) => updateProjectSettings({ render: next }),
    updateProjectSettings,
    assetRegistry,
    setLutPickerOpen,
  };
  return (
    <FieldGroup>
      {RENDERING_SETTINGS_SECTIONS.filter((section) => section.available?.(render) !== false).map((section) => (
        <SettingsSection key={section.id} id={section.id} title={section.title}>
          {section.project(context)}
        </SettingsSection>
      ))}
    </FieldGroup>
  );
}
