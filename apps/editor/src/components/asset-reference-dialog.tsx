import { useMemo, useState } from "react";
import type { IndexedAsset } from "@babylonslate/assets";
import { documentKindForAssetType } from "@babylonslate/core";
import { SelectableText } from "@babylonslate/editor-kit";
import { GraphEditor, assetReferenceNodeTypes, assetReferenceEdgeTypes } from "@babylonslate/graph-ui";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { buildAssetReferenceGraph } from "../lib/asset-reference-graph";
import { displayAssetTitle } from "../lib/content-browser-helpers";

const referenceEdges = {
  markerEnd: { type: "arrowclosed" as const, color: "var(--muted-foreground)" },
};

/** Edge ids are `JSON.stringify([source, target])`, so prefix/suffix selectors find a node's wires. */
function selectedEdgeStyles(guid: string | null): string {
  if (!guid) return "";
  const id = JSON.stringify(guid).replace(/[\\']/g, "\\$&");
  return `.asset-reference-canvas .react-flow__edge:is([data-id^='[${id},'], [data-id$=',${id}]']) .react-flow__edge-path { stroke: var(--graph-state-selected) !important; stroke-opacity: 1; stroke-width: 1.75px !important; }`;
}

export function AssetReferenceDialog({
  rootGuid,
  assets,
  openDocuments,
  onClose,
  onOpenAsset,
}: {
  rootGuid: string;
  assets: readonly IndexedAsset[];
  openDocuments: ReadonlyArray<{ ref: { path: string }; content: unknown }>;
  onClose: () => void;
  onOpenAsset: (asset: IndexedAsset) => void;
}) {
  const graph = useMemo(
    () => buildAssetReferenceGraph(rootGuid, assets, openDocuments),
    [rootGuid, assets, openDocuments],
  );
  const [selectedGuid, setSelectedGuid] = useState<string | null>(rootGuid);
  const [focusVersion, setFocusVersion] = useState(0);
  const root = assets.find((asset) => asset.header.guid === rootGuid);
  const selected = assets.find((asset) => asset.header.guid === selectedGuid);
  const canOpen = (asset: IndexedAsset | undefined): asset is IndexedAsset =>
    !!asset &&
    !asset.placeholder &&
    documentKindForAssetType(asset.header.type) !== null;
  const openAsset = (guid: string) => {
    const asset = assets.find((entry) => entry.header.guid === guid);
    if (!canOpen(asset)) return;
    onClose();
    onOpenAsset(asset);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="editor-dialog-large flex min-h-0 flex-col overflow-hidden"
        data-testid="content-browser-refs-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {displayAssetTitle(root?.header.name ?? rootGuid)} References
          </DialogTitle>
        </DialogHeader>
        <style>{selectedEdgeStyles(selectedGuid)}</style>
        <div
          className="asset-reference-canvas min-h-0 flex-1 overflow-hidden rounded-md border border-border"
          data-testid="asset-reference-canvas"
        >
          <GraphEditor
            key={focusVersion}
            readOnly
            initialGraph={graph}
            nodeTypes={assetReferenceNodeTypes}
            edgeTypes={assetReferenceEdgeTypes}
            defaultEdgeOptions={referenceEdges}
            defaultZoom={1}
            focusedNodeId={rootGuid}
            selectedNodeId={selectedGuid ?? undefined}
            onSelectionChange={(guids) => setSelectedGuid(guids[0] ?? null)}
            onNodeDoubleClick={openAsset}
            deleteKeyCode={null}
          />
        </div>
        <DialogFooter className="shrink-0 justify-between">
          <div className="flex min-w-0 flex-1 flex-col text-xs">
            <span className="truncate" title={selected?.path ?? selectedGuid ?? ""}>
              <SelectableText>
                {selected?.path ??
                  (selectedGuid ? `${selectedGuid} (Missing Asset)` : "No Selection")}
              </SelectableText>
            </span>
            <span className="text-muted-foreground tabular-nums">
              {graph.nodes.length} Assets, {graph.edges.length} Links
            </span>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedGuid(rootGuid);
                setFocusVersion((version) => version + 1);
              }}
            >
              Focus Asset
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canOpen(selected)}
              onClick={() => {
                if (selectedGuid) openAsset(selectedGuid);
              }}
            >
              Open Asset
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
