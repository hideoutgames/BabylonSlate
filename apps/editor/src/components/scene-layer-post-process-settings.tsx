import { normalizeSceneLayerPostProcessStack, type ProjectDocument } from "@haptic/core";
import { Field } from "@haptic/ui/components/field";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { isPostProcessMaterialForPicker } from "../lib/content-browser-helpers";
import { MATERIAL_DOCUMENT_KINDS, useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { PostProcessPassList } from "./post-process-pass-list";

/**
 * Project Settings → Rendering → Scene Layer Post-Processing: the passes Play starts the stack every Scene Layer shares
 * with. A Scene Layer's Inspector shows and edits this same list.
 */
export function SceneLayerPostProcessSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
}: {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
}) {
  // An open Material tab's unsaved domain wins over its saved header.
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const listed = assetRegistry?.list() ?? [];
  const entry = (asset: (typeof listed)[number]) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path });
  return (
    <Field className="settings-row">
      <PostProcessPassList
        idPrefix="setting-scene-layer-post-process"
        title="Post-Process Passes"
        hint="Every Scene Layer draws into one image these passes run over, blended over the world. A Scene Layer's Inspector edits the same list."
        entries={projectDocument.settings.sceneLayerPostProcessStack}
        onChange={(entries) => updateProjectSettings({ sceneLayerPostProcessStack: normalizeSceneLayerPostProcessStack(entries) })}
        assets={listed.map(entry)}
        materialAssets={listed.filter((asset) => isPostProcessMaterialForPicker(asset, materialDocuments)).map(entry)}
      />
    </Field>
  );
}
