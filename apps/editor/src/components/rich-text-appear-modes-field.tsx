import { useMemo } from "react";
import { ArrayProperty } from "@haptic/editor-kit";
import {
  TEXT2D_APPEAR_MODES, TEXT2D_APPEAR_MODE_LABELS, text2DCustomAppearMode, text2DCustomAppearModeClassId,
  type Text2DAppearModeEntry,
} from "@haptic/core";
import { RICH_TEXT_2D_APPEAR_MODE_CLASS_ID } from "@haptic/object-model";
import { useRegistryState } from "../context/document-context";
import { subclassClassEntries } from "../lib/component-property-rows";

type AppearModesFieldProps = {
  value: readonly Text2DAppearModeEntry[];
  defaultValue?: readonly Text2DAppearModeEntry[];
  onChange: (modes: Text2DAppearModeEntry[]) => void;
  /** Class ids of the project's Rich Text 2D Appear Mode Classes. */
  customClassIds?: readonly string[];
  "data-testid"?: string;
};

/** Shared Scene/Prefab constraint on the reusable array property. */
export function RichTextAppearModesField({ value, onChange, defaultValue = [], customClassIds = [], "data-testid": testId }: AppearModesFieldProps) {
  // A chosen Class that no longer exists keeps its entry, so the list still shows what is stored.
  const classIds = [...new Set([...customClassIds, ...value.flatMap((mode) => text2DCustomAppearModeClassId(mode) ?? [])])];
  return <div className="p-2">
    <ArrayProperty<Text2DAppearModeEntry>
      label="Appear Modes" itemLabel="Mode" addLabel="Add Mode"
      value={value} onChange={(next) => onChange(next.includes("instant") ? ["instant"] : next)}
      options={[
        ...TEXT2D_APPEAR_MODES.map((mode) => ({ id: mode, value: mode as Text2DAppearModeEntry, label: TEXT2D_APPEAR_MODE_LABELS[mode] })),
        ...classIds.map((classId) => ({ id: text2DCustomAppearMode(classId), value: text2DCustomAppearMode(classId) as Text2DAppearModeEntry, label: `${classId} (Custom)` })),
      ]}
      unique maxItems={value.includes("instant") ? 1 : TEXT2D_APPEAR_MODES.length - 1 + classIds.length} defaultValue={defaultValue} emptyLabel="Off"
      description="Combine Fade, Scale, Slide and custom modes once each. Instant replaces the other modes. An empty array disables appearing."
      data-testid={testId ?? "rich-text-appear-modes"}
    />
  </div>;
}

/** The field with the open project's Rich Text 2D Appear Mode Classes as its custom modes. */
export function ProjectRichTextAppearModesField(props: Omit<AppearModesFieldProps, "customClassIds">) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const customClassIds = useMemo(() => {
    void registryEpoch;
    return subclassClassEntries(RICH_TEXT_2D_APPEAR_MODE_CLASS_ID, assetRegistry?.list() ?? [])
      .filter((entry) => entry.id !== RICH_TEXT_2D_APPEAR_MODE_CLASS_ID).map((entry) => entry.id);
  }, [assetRegistry, registryEpoch]);
  return <RichTextAppearModesField {...props} customClassIds={customClassIds} />;
}
