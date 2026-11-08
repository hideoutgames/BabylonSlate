import { useEffect, useMemo, useRef, useState } from "react";
import { PropertyGrid, walkAncestry, type PropertyRow } from "@haptic/editor-kit";
import {
  resolveActorDefaults,
  resolveGameInstanceDefaults,
  type ActorDefaults,
  type ActorEventTickMode,
  type GameInstanceDefaults,
  type SerializedGraph,
} from "@haptic/core";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { classIdFromClassAsset, classParentLookup } from "../lib/content-browser-helpers";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

/** Open Class tabs override saved ancestor Actor Defaults. */
const CLASS_KINDS = ["graph"] as const;

type ActorDefaultFlag = "generateHitEvents" | "generateOverlapEvents" | "tickOnPause";

/** The defaults a Class document carries for its instances. */
type ClassDefaults = Pick<SerializedGraph, "actorDefaults" | "gameInstanceDefaults">;

/**
 * The ancestors of `parentClass`, nearest first, and the defaults each ancestor Class
 * authors. Open Class tabs override saved ancestors.
 */
function useAncestorClassDefaults(parentClass: string): { ancestors: string[]; defaultsOf: Record<string, ClassDefaults | undefined> } {
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
  const [savedDefaults, setSavedDefaults] = useState<Record<string, ClassDefaults | undefined>>({});
  useEffect(() => {
    let active = true;
    const closed = new Set(closedAncestorPaths.split("\n"));
    void Promise.all(ancestorAssets.filter(asset => closed.has(asset.path)).map(async asset => {
      const graph = await loadGraphDocument(asset.path).catch(() => null);
      return [classIdFromClassAsset(asset), classDefaultsOf(graph)] as const;
    })).then(entries => { if (active) setSavedDefaults(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [ancestorAssets, closedAncestorPaths, loadGraphDocument]);
  const openDefaults = useMemo(() => Object.fromEntries(ancestorAssets.flatMap(asset => {
    const doc = classDocuments.find(entry => entry.ref.path === asset.path);
    return doc ? [[classIdFromClassAsset(asset), classDefaultsOf(doc.content as SerializedGraph | null)] as const] : [];
  })), [ancestorAssets, classDocuments]);
  // A Class whose tab closes keeps its last open values until the disk read of it lands.
  const lastOpenDefaults = useRef<Record<string, ClassDefaults | undefined>>({});
  useEffect(() => { Object.assign(lastOpenDefaults.current, openDefaults); }, [openDefaults]);
  const defaultsOf = useMemo(
    () => ({ ...lastOpenDefaults.current, ...savedDefaults, ...openDefaults }),
    [openDefaults, savedDefaults],
  );
  return { ancestors, defaultsOf };
}

function classDefaultsOf(graph: SerializedGraph | null | undefined): ClassDefaults | undefined {
  return graph ? { actorDefaults: graph.actorDefaults, gameInstanceDefaults: graph.gameInstanceDefaults } : undefined;
}

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
  const { ancestors, defaultsOf } = useAncestorClassDefaults(parentClass);
  const inherited = resolveActorDefaults(ancestors.map(id => defaultsOf[id]?.actorDefaults));

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
          ...flagRow("tickOnPause", "Tick On Pause"),
          description: "Keep ticking, with this actor's components, Delays and tweens, while the game is paused.",
        },
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

/** Game Instance class defaults; omitted values inherit from the parent Class. */
export function GameInstanceDefaultsGrid({
  parentClass,
  defaults,
  onChange,
}: {
  parentClass: string;
  defaults: GameInstanceDefaults;
  onChange: (next: GameInstanceDefaults) => void;
}) {
  const { ancestors, defaultsOf } = useAncestorClassDefaults(parentClass);
  const inherited = resolveGameInstanceDefaults(ancestors.map(id => defaultsOf[id]?.gameInstanceDefaults));
  return (
    <PropertyGrid
      title="Game Instance Defaults"
      data-testid="inspector-game-instance-defaults"
      rows={[{
        id: "tickOnPause",
        kind: "boolean",
        label: "Tick On Pause",
        description: "Keep ticking, with the Game Instance's Delays and tweens, while the game is paused.",
        value: defaults.tickOnPause ?? inherited.tickOnPause,
        defaultValue: inherited.tickOnPause,
        onChange: (value: boolean) => {
          const next = { ...defaults };
          if (value === inherited.tickOnPause) delete next.tickOnPause;
          else next.tickOnPause = value;
          onChange(next);
        },
      }]}
    />
  );
}
