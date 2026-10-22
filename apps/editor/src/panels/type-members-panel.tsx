import { useState, type MouseEvent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  NumberField,
  PanelFrame,
  TreeView,
  TypeColorMark,
  pinPickerColorVar,
  pinPickerLabel,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { ENUM_VALUE_MAX } from "@haptic/scripting";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { IconActionButton } from "../components/icon-action-button";
import {
  addEnumMember,
  addStructureField,
  moveEnumMember,
  moveStructureField,
  patchEnumMember,
  patchStructureField,
  removeEnumMember,
  removeStructureField,
} from "../lib/asset-settings";
import {
  asEnumAsset,
  asStructureAsset,
  memberKey,
  parseMemberIndex,
} from "../lib/type-asset-payload";

export function TypeMembersPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { selectedMemberId, setSelectedMemberId } = useTypeAssetEditing();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  const kind = doc?.ref.kind;
  const selectedIndex = parseMemberIndex(selectedMemberId);
  // Double-tap, double-click or F2 on a member renames it in place.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };
  // Rows are selected by index, so a moved row takes the selection to its new
  // slot. The click must not reach the row, which would select the old slot.
  const moveRow = (
    event: MouseEvent,
    next: Record<string, unknown>,
    index: number,
  ) => {
    event.stopPropagation();
    commit(next);
    setSelectedMemberId(memberKey(index));
  };

  if (kind === "enum") {
    const asset = asEnumAsset(payload);
    return (
      <PanelFrame
        data-testid="enum-members-panel"
        toolbar={
          <>
            <IconActionButton
              label="Add member"
              onClick={() => {
                const next = addEnumMember(asset);
                commit(next);
                setSelectedMemberId(memberKey(next.members.length - 1));
              }}
              data-testid="enum-add-member"
            >
              <PlusIcon />
            </IconActionButton>
            <IconActionButton
              label="Remove member"
              disabled={selectedIndex === null}
              onClick={() => {
                if (selectedIndex === null) return;
                commit(removeEnumMember(asset, selectedIndex));
                setSelectedMemberId(null);
              }}
              data-testid="enum-remove-member"
            >
              <Trash2Icon />
            </IconActionButton>
          </>
        }
      >
        <TreeView
          nodes={asset.members.map((member, index) => ({
            id: memberKey(index),
            label: member.name,
            depth: 0,
            hasChildren: false,
            expanded: false,
            renamable: true,
            draggable: false,
            trailing: (
              <>
                <NumberField
                  integer
                  min={0}
                  max={ENUM_VALUE_MAX}
                  className="h-6 min-h-6 w-16 text-xs"
                  value={member.value}
                  aria-label={`${member.name} value`}
                  onChange={(value) => commit(patchEnumMember(asset, index, { value }))}
                />
                <MoveButtons
                  name={member.name}
                  first={index === 0}
                  last={index === asset.members.length - 1}
                  onUp={(event) => moveRow(event, moveEnumMember(asset, index, -1), index - 1)}
                  onDown={(event) => moveRow(event, moveEnumMember(asset, index, 1), index + 1)}
                />
              </>
            ),
          }))}
          selectedId={selectedIndex === null ? null : memberKey(selectedIndex)}
          onSelect={(id) => setSelectedMemberId(id)}
          renamingId={renamingId}
          onRenameRequest={setRenamingId}
          onRenameDone={(id, name) => {
            setRenamingId(null);
            const index = parseMemberIndex(id);
            if (name !== null && index !== null) commit(patchEnumMember(asset, index, { name }));
          }}
          emptyLabel="No Members"
          aria-label="Enum Members"
          data-testid="enum-members-tree"
        />
      </PanelFrame>
    );
  }

  if (kind === "structure") {
    const asset = asStructureAsset(payload);
    return (
      <PanelFrame
        data-testid="structure-members-panel"
        toolbar={
          <>
            <IconActionButton
              label="Add field"
              onClick={() => {
                const next = addStructureField(asset);
                commit(next);
                setSelectedMemberId(memberKey(next.fields.length - 1));
              }}
              data-testid="structure-add-field"
            >
              <PlusIcon />
            </IconActionButton>
            <IconActionButton
              label="Remove field"
              disabled={selectedIndex === null}
              onClick={() => {
                if (selectedIndex === null) return;
                commit(removeStructureField(asset, selectedIndex));
                setSelectedMemberId(null);
              }}
              data-testid="structure-remove-field"
            >
              <Trash2Icon />
            </IconActionButton>
          </>
        }
      >
        <TreeView
          nodes={asset.fields.map((field, index) => ({
            id: memberKey(index),
            label: field.name,
            depth: 0,
            hasChildren: false,
            expanded: false,
            renamable: true,
            draggable: false,
            icon: <TypeColorMark colorVar={pinPickerColorVar(field.typeId)} />,
            preview: (
              <span className="text-xs text-muted-foreground">{pinPickerLabel(field.typeId)}</span>
            ),
            trailing: (
              <MoveButtons
                name={field.name}
                first={index === 0}
                last={index === asset.fields.length - 1}
                onUp={(event) => moveRow(event, moveStructureField(asset, index, -1), index - 1)}
                onDown={(event) => moveRow(event, moveStructureField(asset, index, 1), index + 1)}
              />
            ),
          }))}
          selectedId={selectedIndex === null ? null : memberKey(selectedIndex)}
          onSelect={(id) => setSelectedMemberId(id)}
          renamingId={renamingId}
          onRenameRequest={setRenamingId}
          onRenameDone={(id, name) => {
            setRenamingId(null);
            const index = parseMemberIndex(id);
            if (name !== null && index !== null) commit(patchStructureField(asset, index, { name }));
          }}
          emptyLabel="No Fields"
          aria-label="Structure Fields"
          data-testid="structure-fields-tree"
        />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="type-members-panel">
      <p className="p-3 text-sm text-muted-foreground">No members</p>
    </PanelFrame>
  );
}

/** Reorder controls at the end of a member row. */
function MoveButtons({
  name,
  first,
  last,
  onUp,
  onDown,
}: {
  name: string;
  first: boolean;
  last: boolean;
  onUp: (event: MouseEvent) => void;
  onDown: (event: MouseEvent) => void;
}) {
  return (
    <>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${name} up`} disabled={first} onClick={onUp}>
        <ChevronUpIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${name} down`} disabled={last} onClick={onDown}>
        <ChevronDownIcon />
      </Button>
    </>
  );
}
