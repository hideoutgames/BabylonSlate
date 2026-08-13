import type { IDockviewPanelProps } from "dockview-react";
import {
  NumberField,
  PanelFrame,
  TypeColorMark,
  pinPickerColorVar,
  pinPickerLabel,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useDocuments } from "../context/document-context";
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
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const { selectedMemberId, setSelectedMemberId } = useTypeAssetEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  const kind = doc?.ref.kind;
  const selectedIndex = parseMemberIndex(selectedMemberId);

  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
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
        <div className="flex flex-col">
          {asset.members.map((member, index) => {
            const selected = selectedIndex === index;
            return (
              <div
                key={`${member.name}-${index}`}
                className={`flex min-h-[var(--chrome-row,28px)] items-center gap-1 px-2 ${
                  selected ? "bg-accent" : "hover:bg-accent/50"
                }`}
                data-testid={`enum-row-${index}`}
                onClick={() => setSelectedMemberId(memberKey(index))}
              >
                <Input
                  className="h-7 min-h-7 min-w-0 flex-1"
                  value={member.name}
                  aria-label={`Member ${index + 1} name`}
                  onChange={(event) =>
                    commit(
                      patchEnumMember(asset, index, {
                        name: event.target.value,
                      }),
                    )
                  }
                />
                <NumberField
                  className="h-7 min-h-7 w-20"
                  value={member.value}
                  aria-label={`Member ${index + 1} value`}
                  onChange={(value) =>
                    commit(patchEnumMember(asset, index, { value }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${member.name} up`}
                  disabled={index === 0}
                  onClick={() => commit(moveEnumMember(asset, index, -1))}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${member.name} down`}
                  disabled={index === asset.members.length - 1}
                  onClick={() => commit(moveEnumMember(asset, index, 1))}
                >
                  <ChevronDownIcon />
                </Button>
              </div>
            );
          })}
        </div>
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
        <div className="flex flex-col">
          {asset.fields.map((field, index) => {
            const selected = selectedIndex === index;
            return (
              <div
                key={`${field.name}-${index}`}
                className={`flex min-h-[var(--chrome-row,28px)] items-center gap-1 px-2 ${
                  selected ? "bg-accent" : "hover:bg-accent/50"
                }`}
                data-testid={`structure-row-${index}`}
                onClick={() => setSelectedMemberId(memberKey(index))}
              >
                <TypeColorMark colorVar={pinPickerColorVar(field.typeId)} />
                <Input
                  className="h-7 min-h-7 min-w-0 flex-1"
                  value={field.name}
                  aria-label={`Field ${index + 1} name`}
                  onChange={(event) =>
                    commit(
                      patchStructureField(asset, index, {
                        name: event.target.value,
                      }),
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {pinPickerLabel(field.typeId)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${field.name} up`}
                  disabled={index === 0}
                  onClick={() => commit(moveStructureField(asset, index, -1))}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${field.name} down`}
                  disabled={index === asset.fields.length - 1}
                  onClick={() => commit(moveStructureField(asset, index, 1))}
                >
                  <ChevronDownIcon />
                </Button>
              </div>
            );
          })}
        </div>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="type-members-panel">
      <p className="p-3 text-sm text-muted-foreground">No members</p>
    </PanelFrame>
  );
}
