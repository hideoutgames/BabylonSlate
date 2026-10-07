import { useEffect, useMemo, useState } from "react";
import { PropertyGrid, walkAncestry, type PropertyRow } from "@babylonslate/editor-kit";
import {
  resolveActorDefaults,
  type ActorDefaults,
  type ActorEventTickMode,
  type SerializedGraph,
} from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { classIdFromClassAsset, classParentLookup } from "../lib/content-browser-helpers";

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
  const { assetRegistry, registryEpoch, openDocuments, loadGraphDocument } = useDocuments();
  const assets = useMemo(() => { void registryEpoch; return assetRegistry?.list() ?? []; }, [assetRegistry, registryEpoch]);
  const ancestors = useMemo(() => walkAncestry(parentClass, classParentLookup(assets)), [assets, parentClass]);
  const [ancestorDefaults, setAncestorDefaults] = useState<Record<string, ActorDefaults | undefined>>({});
  useEffect(() => {
    let active = true;
    const ids = new Set(ancestors);
    void Promise.all(assets.filter(asset => asset.header.type === "Class" && ids.has(classIdFromClassAsset(asset))).map(async asset => {
      const open = openDocuments.find(doc => doc.ref.path === asset.path && doc.ref.kind === "graph");
      const graph = open ? open.content as SerializedGraph | null : await loadGraphDocument(asset.path).catch(() => null);
      return [classIdFromClassAsset(asset), graph?.actorDefaults] as const;
    })).then(entries => { if (active) setAncestorDefaults(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [ancestors, assets, loadGraphDocument, openDocuments]);
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
