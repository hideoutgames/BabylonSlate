import type { DebugBehaviourTree } from "@babylonslate/bridge";
import { sanitizeInspectValue } from "@babylonslate/object-model";
import { useState } from "react";
import {
  humanizePropertyLabel,
  SelectableText,
} from "@babylonslate/editor-kit";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@babylonslate/ui/components/empty";
import { Badge } from "@babylonslate/ui/components/badge";
import { cn } from "@babylonslate/ui/lib/utils";

export function DebugBehaviourTreeDialog({
  open,
  onOpenChange,
  trees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trees: readonly DebugBehaviourTree[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const key = (tree: DebugBehaviourTree) =>
    `${tree.actorGuid}:${tree.slotId}:${tree.treeGuid}`;
  const tree = trees.find((entry) => key(entry) === selected) ?? trees[0];
  const label = (entry: DebugBehaviourTree) =>
    `${entry.actorName} (${entry.treeName})`;
  const active = new Set(tree?.stack.map((entry) => entry.nodeId) ?? []);
  if (tree?.btNodeId) active.add(tree.btNodeId);
  const names = new Map(
    tree?.nodes.map((node) => [
      node.id,
      humanizePropertyLabel(node.classId || node.kind),
    ]) ?? [],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="editor-dialog-large flex min-h-0 flex-col gap-3"
        data-testid="behaviour-tree-debugger"
      >
        <DialogHeader>
          <DialogTitle>Behaviour Tree Debugger</DialogTitle>
        </DialogHeader>
        {tree ? (
          <>
            <Field>
              <FieldLabel htmlFor="bt-debug-selection">
                Behaviour Tree
              </FieldLabel>
              <Select
                value={key(tree)}
                onValueChange={setSelected}
                items={trees.map((entry) => ({
                  value: key(entry),
                  label: label(entry),
                }))}
              >
                <SelectTrigger
                  id="bt-debug-selection"
                  aria-label="Behaviour Tree"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {trees.map((entry) => (
                      <SelectItem key={key(entry)} value={key(entry)}>
                        {label(entry)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="secondary">
                {humanizePropertyLabel(tree.status)}
              </Badge>
              <SelectableText>
                Active:{" "}
                {names.get(tree.btNodeId ?? "") ?? tree.btNodeId ?? "None"}
              </SelectableText>
            </div>
            <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-2">
              <section className="min-w-0" aria-label="Tree Logic">
                <h3 className="mb-2 text-sm font-medium">Tree Logic</h3>
                <ul className="flex flex-col gap-1">
                  {tree.nodes.map((node) => (
                    <li
                      key={node.id}
                      data-testid={`bt-debug-node-${node.id}`}
                      data-active={active.has(node.id)}
                      className={cn(
                        "border-l-2 border-transparent px-2 py-1 text-xs",
                        active.has(node.id) && "border-primary bg-accent",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <SelectableText>{names.get(node.id)}</SelectableText>
                        <Badge variant="outline">
                          {humanizePropertyLabel(
                            tree.lastResults[node.id] ?? "idle",
                          )}
                        </Badge>
                      </div>
                      {node.children.length > 0 && (
                        <p className="mt-1 text-muted-foreground">
                          <SelectableText>
                            Children:{" "}
                            {node.children
                              .map((id) => names.get(id) ?? id)
                              .join(" → ")}
                          </SelectableText>
                        </p>
                      )}
                      {[
                        ...node.decorators.map((item) => ({
                          ...item,
                          role: "Decorator",
                        })),
                        ...node.services.map((item) => ({
                          ...item,
                          role: "Service",
                        })),
                      ].map((item) => (
                        <p key={item.id} className="mt-1 text-muted-foreground">
                          <SelectableText>
                            {item.role}: {humanizePropertyLabel(item.classId)} ·{" "}
                            {humanizePropertyLabel(
                              tree.lastResults[item.id] ?? "idle",
                            )}
                          </SelectableText>
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
              <div className="flex min-w-0 flex-col gap-4">
                <section aria-label="Execution Stack">
                  <h3 className="mb-2 text-sm font-medium">Execution Stack</h3>
                  <ol className="flex flex-col gap-1 text-xs">
                    {tree.stack.map((entry, index) => (
                      <li key={`${index}-${entry.nodeId}`}>
                        <SelectableText>
                          {index + 1}. {names.get(entry.nodeId) ?? entry.nodeId}{" "}
                          · Child {entry.childIndex + 1} ·{" "}
                          {entry.opened ? "Open" : "Closed"}
                        </SelectableText>
                      </li>
                    ))}
                  </ol>
                </section>
                <section aria-label="Blackboard">
                  <h3 className="mb-2 text-sm font-medium">Blackboard</h3>
                  <dl className="flex flex-col gap-2 text-xs">
                    {Object.entries(tree.blackboard).map(([name, value]) => (
                      <div key={name}>
                        <dt className="font-medium">
                          <SelectableText>
                            {humanizePropertyLabel(name)}
                          </SelectableText>
                        </dt>
                        <dd className="whitespace-pre-wrap break-all font-mono text-muted-foreground">
                          <SelectableText>
                              {JSON.stringify(sanitizeInspectValue(value), null, 2)}
                          </SelectableText>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            </div>
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Running Behaviour Trees</EmptyTitle>
              <EmptyDescription>
                Live trees appear here when actors start them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </DialogContent>
    </Dialog>
  );
}
