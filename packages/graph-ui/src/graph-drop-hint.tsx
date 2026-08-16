import { Badge } from "@babylonslate/ui/components/badge";
import { BanIcon, PlusIcon } from "lucide-react";

export type GraphDropHintState = {
  clientX: number;
  clientY: number;
  allowed: boolean;
  label?: string;
};

/** Floating badge while dragging Class/Component rows onto the graph. */
export function GraphDropHint({
  hint,
}: {
  hint: GraphDropHintState | null;
}) {
  if (!hint) return null;
  return (
    <div
      className="pointer-events-none fixed z-50"
      style={{ left: hint.clientX + 12, top: hint.clientY + 12 }}
      data-testid="graph-member-drop-hint"
      data-allowed={hint.allowed ? "true" : "false"}
    >
      <Badge
        variant={hint.allowed ? "default" : "secondary"}
        className="flex items-center gap-1 shadow-md"
      >
        {hint.allowed ? (
          <PlusIcon className="size-3.5" aria-hidden />
        ) : (
          <BanIcon className="size-3.5" aria-hidden />
        )}
        {hint.label ?? (hint.allowed ? "Add Node" : "Cannot Drop")}
      </Badge>
    </div>
  );
}
