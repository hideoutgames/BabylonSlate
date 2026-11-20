import { useState, type ReactNode } from "react";
import {
  AssetPicker,
  AssetPickerControl,
  EntryListEditor,
  LabelHint,
  PropertyGrid,
  assetRowIdentity,
  selectedPickerIdentity,
  type AssetPickerEntry,
} from "@haptic/editor-kit";
import { newGuid, type ScenePostProcessEntry } from "@haptic/core";
import { HashIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@haptic/ui/components/dialog";
import { Switch } from "@haptic/ui/components/switch";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { IconActionButton } from "./icon-action-button";

/** One pass of a post-process stack: a Scene's, or the Scene Layer post-processing every layer shares. */
export type PostProcessPass = ScenePostProcessEntry & { id: string };

/** Which pass the Material picker is choosing for: a new one, an existing one by Entry ID, or none (closed). */
export type PostProcessPassPick = "add" | { id: string } | null;

export interface PostProcessPassListProps {
  /**
   * Prefix of the controls' ids and test ids: the list is `<prefix>-stack`, a pass's Material `<prefix>-<index>-material`,
   * its switch `<prefix>-<index>-enabled`, its Entry ID `<prefix>-<id>-entry-id` and the picker `<prefix>-picker`.
   */
  idPrefix: string;
  title: string;
  /** The title's tooltip, for what the list cannot say itself. */
  hint?: ReactNode;
  entries: readonly PostProcessPass[];
  /** The edited passes, in order; the owner normalizes and stores them. */
  onChange: (entries: PostProcessPass[]) => void;
  /** Every asset, to name a pass's Material. */
  assets: readonly AssetPickerEntry[];
  /** The post-process Materials and Material Instances the picker offers. */
  materialAssets: AssetPickerEntry[];
  /** Each pass's Scalable switch (a Scene's passes). Scene Layers always draw at full resolution. */
  scalable?: boolean;
  /** Controlled picker state, for an owner that keeps it across remounts (the Inspector); internal otherwise. */
  pick?: PostProcessPassPick;
  onPickChange?: (pick: PostProcessPassPick) => void;
}

function PostProcessEntryId({ idPrefix, id, index }: { idPrefix: string; id: string; index: number }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <IconActionButton
            label={`Pass ${index + 1} Entry ID`}
            className="shrink-0 pointer-coarse:size-11"
          />
        }
      >
        <HashIcon />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pass {index + 1} Entry ID</DialogTitle>
          <DialogDescription>
            Copy this ID to target this pass with Get Post Process Entry.
          </DialogDescription>
        </DialogHeader>
        <PropertyGrid density="compact" rows={[{
          kind: "text",
          id: `${idPrefix}-${id}-entry-id`,
          label: "Entry ID",
          value: id,
          readOnly: true,
          onChange: () => {},
        }]} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * An ordered post-process pass list: each pass's Material, Entry ID and Enabled switch (and Scalable for a Scene),
 * with the post-process Material picker that adds and replaces passes (None removes one).
 */
export function PostProcessPassList({
  idPrefix,
  title,
  hint,
  entries,
  onChange,
  assets,
  materialAssets,
  scalable = false,
  pick: controlledPick,
  onPickChange,
}: PostProcessPassListProps) {
  const [ownPick, setOwnPick] = useState<PostProcessPassPick>(null);
  const pick = controlledPick === undefined ? ownPick : controlledPick;
  const setPick = (next: PostProcessPassPick) => {
    if (onPickChange) onPickChange(next);
    else setOwnPick(next);
  };
  const heading = <span className="text-sm font-medium">{title}</span>;
  return (
    <>
      <div className="flex flex-col gap-1">
        {hint ? <LabelHint hint={hint}>{heading}</LabelHint> : heading}
        <EntryListEditor
          data-testid={`${idPrefix}-stack`}
          items={entries}
          getItemKey={(item) => item.id}
          addLabel="Add Pass"
          countNoun={{ one: "pass", other: "passes" }}
          onAdd={() => setPick("add")}
          onChange={onChange}
          renderItemHeader={({ item, index }) => {
            const asset = assets.find((entry) => entry.guid === item.materialGuid);
            const id = `${idPrefix}-${index}-material`;
            return (
              <div className="flex items-center gap-1">
                <Field className="min-w-0 flex-1 gap-0">
                  <FieldLabel className="sr-only" htmlFor={id}>
                    Pass {index + 1} Material
                  </FieldLabel>
                  <AssetPickerControl value={item.materialGuid}>
                    <Button
                      type="button"
                      id={id}
                      variant="outline"
                      size="sm"
                      className="w-full min-w-0 justify-start pointer-coarse:min-h-11"
                      title={asset ? `${asset.name} — ${asset.path}` : `Missing Asset: ${item.materialGuid}`}
                      data-testid={id}
                      onClick={() => setPick({ id: item.id })}
                    >
                      {selectedPickerIdentity({ ...assetRowIdentity(asset), displayType: undefined }, "Missing Asset")}
                    </Button>
                  </AssetPickerControl>
                </Field>
                <PostProcessEntryId idPrefix={idPrefix} id={item.id} index={index} />
              </div>
            );
          }}
          renderItem={({ item, index, onChange: change }) => (
            <div className="flex items-center justify-between gap-2 px-2 pointer-coarse:flex-wrap">
              <Field orientation="horizontal" className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11">
                <FieldLabel htmlFor={`${idPrefix}-${index}-enabled`}>Enabled</FieldLabel>
                <Switch
                  size="sm"
                  className="pointer-coarse:after:-inset-y-[15px]"
                  id={`${idPrefix}-${index}-enabled`}
                  data-testid={`${idPrefix}-${index}-enabled`}
                  aria-label={`Pass ${index + 1} Enabled`}
                  checked={item.enabled !== false}
                  onCheckedChange={(enabled) => change({ ...item, enabled })}
                />
              </Field>
              {scalable ? (
                <Field orientation="horizontal" className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11">
                  <LabelHint hint="Quality settings may draw this pass at a lower resolution.">
                    <FieldLabel htmlFor={`${idPrefix}-${index}-scalable`}>Scalable</FieldLabel>
                  </LabelHint>
                  <Switch
                    size="sm"
                    className="pointer-coarse:after:-inset-y-[15px]"
                    id={`${idPrefix}-${index}-scalable`}
                    aria-label={`Pass ${index + 1} Scalable Resolution`}
                    checked={item.scalable === true}
                    onCheckedChange={(next) => change({ ...item, scalable: next })}
                  />
                </Field>
              ) : null}
            </div>
          )}
        />
      </div>
      <AssetPicker
        open={pick !== null}
        onOpenChange={(open) => { if (!open) setPick(null); }}
        assets={materialAssets}
        allowedTypes={["Material", "MaterialInstance"]}
        createTypes={["Material"]}
        createOptions={{ materialDomain: "postProcess" }}
        title="Pick Post-Process Material"
        allowNone={pick !== "add"}
        onPick={(materialGuid) => {
          const stack = [...entries];
          if (pick === "add") {
            if (materialGuid) stack.push({ id: newGuid(), materialGuid, enabled: true });
          } else if (pick) {
            const index = stack.findIndex((entry) => entry.id === pick.id);
            if (index < 0) {
              setPick(null);
              return;
            }
            if (!materialGuid) stack.splice(index, 1);
            else stack[index] = { ...stack[index]!, materialGuid };
          }
          onChange(stack);
          setPick(null);
        }}
        data-testid={`${idPrefix}-picker`}
      />
    </>
  );
}
