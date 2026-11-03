import { useMemo, useState } from "react";
import {
  GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE,
  GLOBAL_PARAMETER_TYPE_LABELS,
  type GlobalParameter,
} from "@haptic/core";
import { AssetPicker, PropertyGrid, assetRowIdentity, type PropertyRow } from "@haptic/editor-kit";
import { useRegistryState } from "../context/document-context";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";

const NOT_IN_COLLECTION = "__not-in-collection__";
const NONE = "__none__";

/**
 * Inspector rows of a Material or Particle Graph **Global Parameter** node: the Global Parameter
 * Collection, then one of its parameters. Picking another collection clears the parameter.
 */
export function GlobalParameterNodePicker({
  collectionGuid,
  parameterId,
  onChange,
  testId,
}: {
  collectionGuid: string;
  parameterId: string;
  /** `parameter` null: the collection alone, without a parameter. */
  onChange: (collectionGuid: string, parameter: GlobalParameter | null) => void;
  testId: string;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const catalog = useGlobalParameterCatalog();
  const [open, setOpen] = useState(false);
  const collections = useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    if (!open) return [];
    return (assetRegistry?.list() ?? [])
      .filter((asset) => asset.header.type === GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE)
      .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  }, [assetRegistry, registryEpoch, open]);
  const collection = collectionGuid ? assetRegistry?.getByGuid(collectionGuid) : undefined;
  const parameters = collectionGuid ? (catalog[collectionGuid] ?? []) : [];
  const known = parameters.some((parameter) => parameter.id === parameterId);
  const rows: PropertyRow[] = [
    {
      id: `${testId}-collection`,
      kind: "asset",
      label: "Collection",
      value: collectionGuid || null,
      placeholder: "None",
      assetTypes: [GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE],
      onPick: () => setOpen(true),
      onChange: (guid) => onChange(guid ?? "", null),
      ...assetRowIdentity(collection ? { name: collection.header.name, type: collection.header.type } : undefined),
    },
    {
      id: `${testId}-parameter`,
      kind: "enum",
      label: "Parameter",
      value: !parameterId ? NONE : known ? parameterId : NOT_IN_COLLECTION,
      disabled: !collectionGuid,
      options: [
        { value: NONE, label: "None" },
        ...parameters.map((parameter) => ({
          value: parameter.id,
          label: `${parameter.name} (${GLOBAL_PARAMETER_TYPE_LABELS[parameter.type]})`,
        })),
        ...(parameterId && !known ? [{ value: NOT_IN_COLLECTION, label: "(Not In Collection)", disabled: true }] : []),
      ],
      onChange: (id) => onChange(collectionGuid, parameters.find((parameter) => parameter.id === id) ?? null),
    },
  ];
  return (
    <>
      <PropertyGrid density="compact" rows={rows} data-testid={testId} />
      <AssetPicker
        open={open}
        onOpenChange={setOpen}
        assets={collections}
        allowedTypes={[GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE]}
        title="Pick Global Parameter Collection"
        allowNone
        onPick={(guid) => {
          if ((guid ?? "") !== collectionGuid) onChange(guid ?? "", null);
          setOpen(false);
        }}
        data-testid={`${testId}-collection-picker`}
      />
    </>
  );
}
