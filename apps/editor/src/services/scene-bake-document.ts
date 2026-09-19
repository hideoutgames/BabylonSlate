import type { SerializedScene } from "@babylonslate/core";
import {
  stableStringify,
  type AssetRegistry,
  type BakePublicationOwner,
} from "@babylonslate/assets";
import {
  SetSceneSettingCommand,
  type EditCommand,
  type EditSession,
} from "@babylonslate/edit";
import type { DocumentService } from "./document-service";

export interface SceneBakeDocumentOwner {
  scene: SerializedScene;
  sceneGuid: string;
  generation: number;
  rootId: string;
  isCurrent(): boolean;
  commit(guid: string, expected: BakePublicationOwner): boolean;
}

/** Synchronous document/CAS boundary, independent of React's last rendered snapshot. */
export function captureSceneBakeDocument(options: {
  documents: DocumentService;
  edits: EditSession;
  registry: AssetRegistry;
  documentId: string;
  projectIdentity: () => unknown;
  canWrite: () => boolean;
  onApplied: (command: EditCommand<SerializedScene>) => void;
}): SceneBakeDocumentOwner {
  const { documents, registry, documentId } = options;
  const document = documents.getDocument(documentId);
  if (
    !document ||
    document.ref.kind !== "scene" ||
    !document.content ||
    !options.canWrite()
  )
    throw new Error("Open a writable Scene before baking lighting.");
  const scene = document.content as SerializedScene;
  const sceneAsset = registry
    .list()
    .find(
      (asset) =>
        asset.path === document.ref.path && asset.header.type === "Scene",
    );
  if (
    !sceneAsset ||
    sceneAsset.placeholder ||
    registry.getRoot(sceneAsset.rootId)?.readOnly
  )
    throw new Error(
      "The Scene needs a writable project asset before baking lighting.",
    );
  const generation = documents.contentRevision(documentId);
  const project = options.projectIdentity();
  const projectIdentity = stableStringify(project);
  const sourceSignature = () =>
    stableStringify({
      assets: registry
        .list()
        .filter((asset) =>
          ["Material", "MaterialFunction", "Texture"].includes(
            asset.header.type,
          ),
        )
        .map((asset) => [asset.rootId, asset.path, asset.header])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      documents: documents
        .getOpenDocumentsOrdered()
        .filter((entry) =>
          ["material", "material-function"].includes(entry.ref.kind),
        )
        .map((entry) => [
          entry.id,
          documents.contentRevision(entry.id),
          entry.content,
        ]),
    });
  const sources = sourceSignature();
  const isCurrent = () =>
    documents.getDocument(documentId) === document &&
    document.content === scene &&
    documents.contentRevision(documentId) === generation &&
    registry.getByGuid(sceneAsset.header.guid)?.path === sceneAsset.path &&
    registry.getByGuid(sceneAsset.header.guid)?.rootId === sceneAsset.rootId &&
    stableStringify(options.projectIdentity()) === projectIdentity &&
    sourceSignature() === sources;
  return {
    scene,
    sceneGuid: sceneAsset.header.guid,
    generation,
    rootId: sceneAsset.rootId,
    isCurrent,
    commit(guid, expected) {
      if (
        !isCurrent() ||
        !options.canWrite() ||
        expected.sceneGuid !== sceneAsset.header.guid ||
        expected.generation !== generation
      )
        return false;
      const candidate = registry.getByGuid(guid);
      if (
        !candidate ||
        candidate.placeholder ||
        candidate.header.type !== "BakedLighting"
      )
        return false;
      // No await from the exact ownership check through history/dirty/reference mutation.
      const result = options.edits.apply(
        documentId,
        scene,
        new SetSceneSettingCommand(
          "bakedLightingAssetGuid",
          scene.settings.bakedLightingAssetGuid,
          guid,
        ),
      );
      documents.updateScene(documentId, result.doc);
      options.onApplied(result.command);
      return true;
    },
  };
}
