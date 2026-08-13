import type { IDockviewPanelProps } from "dockview-react";
import { PanelFrame } from "@babylonslate/editor-kit";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { IconActionButton } from "../components/icon-action-button";
import {
  addScriptInterfaceMethod,
  removeScriptInterfaceMethod,
} from "../lib/asset-settings";
import {
  asScriptInterfaceAsset,
  memberKey,
  parseMemberIndex,
} from "../lib/type-asset-payload";

export function InterfaceMethodsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const { selectedMemberId, setSelectedMemberId } = useTypeAssetEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const asset = asScriptInterfaceAsset(
    (doc?.content ?? {}) as Record<string, unknown>,
  );
  const selectedIndex = parseMemberIndex(selectedMemberId);

  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };

  return (
    <PanelFrame
      data-testid="interface-methods-panel"
      toolbar={
        <>
          <IconActionButton
            label="Add method"
            onClick={() => {
              const next = addScriptInterfaceMethod(asset);
              commit(next);
              setSelectedMemberId(memberKey(next.methods.length - 1));
            }}
            data-testid="interface-add-method"
          >
            <PlusIcon />
          </IconActionButton>
          <IconActionButton
            label="Remove method"
            disabled={selectedIndex === null}
            onClick={() => {
              if (selectedIndex === null) return;
              commit(removeScriptInterfaceMethod(asset, selectedIndex));
              setSelectedMemberId(null);
            }}
            data-testid="interface-remove-method"
          >
            <Trash2Icon />
          </IconActionButton>
        </>
      }
    >
      {asset.methods.length === 0 ? (
        <Empty data-testid="interface-methods-empty">
          <EmptyHeader>
            <EmptyTitle>No Methods</EmptyTitle>
            <EmptyDescription>
              Add a method to author its signature.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col">
          {asset.methods.map((method, index) => {
            const selected = selectedIndex === index;
            return (
              <button
                key={`${method.name}-${index}`}
                type="button"
                className={`flex min-h-[var(--chrome-row,28px)] items-center px-2 text-left text-sm ${
                  selected ? "bg-accent font-medium" : "hover:bg-accent/50"
                }`}
                data-testid={`interface-method-${index}`}
                onClick={() => setSelectedMemberId(memberKey(index))}
              >
                {method.name}
              </button>
            );
          })}
        </div>
      )}
    </PanelFrame>
  );
}
