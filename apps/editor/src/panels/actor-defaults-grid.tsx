import { useEffect, useMemo, useRef, useState } from "react";
import { PropertyGrid, walkAncestry, type PropertyRow } from "@haptic/editor-kit";
import {
  resolveActorDefaults,
  type ActorDefaults,
  type ActorEventTickMode,
  type SerializedGraph,
} from "@haptic/core";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { classIdFromClassAsset, classParentLookup } from "../lib/content-browser-helpers";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

/** Open Class tabs override saved ancestor Actor Defaults. */
const CLASS_KINDS = ["graph"] as const;

type ActorDefaultFlag = "generateHitEvents" | "generateOverlapEvents";

/** Actor Defaults authored on Prefab Root; omitted values inherit from the parent Class. */
export function ActorDefaultsGrid({
  parentClass,
  defaults,
  onChange,
}: {
  parentClass: string;
  defaults: ActorDefaults;
  onChange: (next: ActorDefaults) => void;
}) {
  const { loadGraphDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const assets = useMemo(() => { void registryEpoch; return assetRegistry?.list() ?? []; }, [assetRegistry, registryEpoch]);
  const ancestors = useMemo(() => walkAncestry(parentClass, classParentLookup(assets)), [assets, parentClass]);
  const ancestorAssets = useMemo(() => {
    const ids = new Set(ancestors);
    return assets.filter(asset => asset.header.type === "Class" && ids.has(classIdFromClassAsset(asset)));
  }, [ancestors, assets]);
  // Closed ancestors are read from disk only when that set changes, not on every edit to an open Class.
  const closedAncestorPaths = ancestorAssets
    .filter(asset => !classDocuments.some(doc => doc.ref.path === asset.path))
    .map(asset => asset.path)
    .join("\n");
  const [savedDefaults, setSavedDefaults] = useState<Record<string, ActorDefaults | undefined>>({});
  useEffect(() => {
    let active = true;
    const closed = new Set(closedAncestorPaths.split("\n"));
    void Promise.all(ancestorAssets.filter(asset => closed.has(asset.path)).map(async asset => {
      const graph = await loadGraphDocument(asset.path).catch(() => null);
      return [classIdFromClassAsset(asset), graph?.actorDefaults] as const;
    })).then(entries => { if (active) setSavedDefaults(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [ancestorAssets, closedAncestorPaths, loadGraphDocument]);
  const openDefaults = useMemo(() => Object.fromEntries(ancestorAssets.flatMap(asset => {
    const doc = classDocuments.find(entry => entry.ref.path === asset.path);
    return doc ? [[classIdFromClassAsset(asset), (doc.content as SerializedGraph | null)?.actorDefaults] as const] : [];
  })), [ancestorAssets, classDocuments]);
  // A Class whose tab closes keeps its last open values until the disk read of it lands.
  const lastOpenDefaults = useRef<Record<string, ActorDefaults | undefined>>({});
  useEffect(() => { Object.assign(lastOpenDefaults.current, openDefaults); }, [openDefaults]);
  const ancestorDefaults = useMemo(
    () => ({ ...lastOpenDefaults.current, ...savedDefaults, ...openDefaults }),
    [openDefaults, savedDefaults],
  );
  const inherited = resolveActorDefaults(ancestors.map(id => ancestorDefaults[id]));

  const writeFlag = (key: ActorDefaultFlag, value: boolean) => {
    const next = { ...defaults };
    if (value === inherited[key]) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const flagRow = (key: ActorDefaultFlag, label: string): PropertyRow => ({
    id: key,
    kind: "boolean",
    label,
    value: defaults[key] ?? inherited[key],
    defaultValue: inherited[key],
    onChange: (value: boolean) => writeFlag(key, value),
  });
  const eventTick = defaults.eventTick ?? "inherit";

  return (
    <PropertyGrid
      title="Actor Defaults"
      data-testid="inspector-actor-defaults"
      rows={[
        flagRow("generateHitEvents", "Generate Hit Events"),
        flagRow("generateOverlapEvents", "Generate Overlap Events"),
        {
          id: "eventTick",
          kind: "enum",
          label: "Event Tick",
          value: eventTick,
          defaultValue: "inherit",
          options: [
            { value: "inherit", label: `Inherit (${inherited.eventTick ? "Enabled" : "Disabled"})` },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ],
          onChange: (value: string) => {
            const next = { ...defaults };
            if (value === "inherit") delete next.eventTick;
            else next.eventTick = value as ActorEventTickMode;
            onChange(next);
          },
        },
      ]}
    />
  );
}
