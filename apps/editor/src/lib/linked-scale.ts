import { useMemo } from "react";
import { useAppSettings } from "../context/app-settings-context";
import { classIdForGraphPath } from "../services/script-compiler";

/**
 * Each Scale field's owner; scene instances can share template component ids,
 * so components are keyed under their actor or Class.
 */
export const scaleLinkKey = {
  actor: (actorId: string) => `actor:${actorId}`,
  actorComponent: (actorId: string, componentId: string) =>
    `actor:${actorId}/component:${componentId}`,
  classComponent: (classId: string, componentId: string) =>
    `class:${classId}/component:${componentId}`,
  collider: (colliderId: string) => `collider:${colliderId}`,
  /** A Simulation selection: its component, or the actor itself. */
  runtime: (target: { actorGuid: string; componentGuid?: string }) =>
    target.componentGuid
      ? scaleLinkKey.actorComponent(target.actorGuid, target.componentGuid)
      : scaleLinkKey.actor(target.actorGuid),
};

/**
 * Class a Class or Prefab document's components belong to: the Class graph's
 * id, or `Actor` for a Prefab asset. Their Scale links are keyed under it.
 */
export function documentComponentClassId(
  ref: { kind: string; path?: string } | undefined,
): string {
  return ref?.kind === "graph" && ref.path ? classIdForGraphPath(ref.path) : "Actor";
}

/**
 * The scale gizmo scales linked when every owner it scales has its Scale
 * linked, as the Inspector's (selection) Scale toggle shows.
 */
export function scaleGizmoLinked(
  linkedScale: Pick<LinkedScale, "isLinked">,
  keys: readonly string[],
): boolean {
  return keys.length > 0 && keys.every((key) => linkedScale.isLinked(key));
}

/** A Scale row's link toggle state. */
export interface ScaleLink {
  linked: boolean;
  onLinkedChange: (linked: boolean) => void;
}

export interface LinkedScale {
  isLinked: (key: string) => boolean;
  setLinked: (keys: readonly string[], linked: boolean) => void;
  /** One owner's toggle state. */
  link: (key: string) => ScaleLink;
}

/** Inspector Scale links, remembered per owner on this device and off until linked. */
export function useLinkedScale(): LinkedScale {
  const { settings, updateSettings } = useAppSettings();
  const keys = settings.linkedScaleKeys;
  return useMemo(() => {
    const linkedKeys = new Set(keys);
    const setLinked = (changed: readonly string[], linked: boolean) => {
      void updateSettings((settings) => {
        const rest = settings.linkedScaleKeys.filter((key) => !changed.includes(key));
        settings.linkedScaleKeys = linked ? [...rest, ...changed] : rest;
      }).catch((error) => console.warn("Could not remember the Scale link:", error));
    };
    return {
      isLinked: (key) => linkedKeys.has(key),
      setLinked,
      link: (key) => ({
        linked: linkedKeys.has(key),
        onLinkedChange: (linked) => setLinked([key], linked),
      }),
    };
  }, [keys, updateSettings]);
}
