import { GitBranchIcon, LayoutGridIcon } from "lucide-react";
import type { ChromeDocumentKind } from "@haptic/core";

/** The icon of a pinned chrome tab, wherever documents are listed. */
export function ChromeDocumentIcon({ kind, className }: { kind: ChromeDocumentKind; className?: string }) {
  return kind === "source-control" ? <GitBranchIcon className={className} /> : <LayoutGridIcon className={className} />;
}
