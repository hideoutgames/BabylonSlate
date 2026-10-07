import { AssetPicker } from "@babylonslate/editor-kit";
import { useRegistryState } from "../context/document-context";
import { isParticleMaterialForPicker } from "../lib/content-browser-helpers";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";

/**
 * Particle-domain Materials only; an open Material tab's domain wins over its header.
 * Basic emitter and Particle Graph Details and Previews share it.
 */
export function ParticleMaterialPicker({
  open,
  onOpenChange,
  onPick,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (guid: string | null) => void;
  testId: string;
}) {
  const { assetRegistry } = useRegistryState();
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const assets = (assetRegistry?.list() ?? [])
    .filter((asset) => isParticleMaterialForPicker(asset, materialDocuments))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  return (
    <AssetPicker
      open={open}
      onOpenChange={onOpenChange}
      assets={assets}
      allowedTypes={["Material", "MaterialInstance"]}
      createTypes={["Material"]}
      createOptions={{ materialDomain: "particle" }}
      title="Pick Particle Material"
      allowNone
      onPick={(guid) => {
        onPick(guid);
        onOpenChange(false);
      }}
      data-testid={testId}
    />
  );
}
