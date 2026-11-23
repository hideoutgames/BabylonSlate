import { useSyncExternalStore } from "react";
import { FileCodeIcon, FileTextIcon, GitBranchIcon, LayoutGridIcon } from "lucide-react";
import type { ChromeDocumentKind } from "@haptic/core";
import {
  getTextEditorSession,
  listTextEditorSessions,
  subscribeTextEditorSessions,
} from "../services/text-editor-sessions";

/** The icon of a pinned chrome tab, wherever documents are listed. */
export function ChromeDocumentIcon({ kind, className }: { kind: ChromeDocumentKind; className?: string }) {
  return kind === "source-control" ? <GitBranchIcon className={className} /> : <LayoutGridIcon className={className} />;
}

/** A Text Editor tab's icon: code for code and formula sessions, text otherwise. */
export function TextEditorDocumentIcon({ sessionId, className }: { sessionId: string; className?: string }) {
  useSyncExternalStore(subscribeTextEditorSessions, listTextEditorSessions);
  const mode = getTextEditorSession(sessionId)?.mode;
  return mode === "javascript" || mode === "glsl" || mode === "formula"
    ? <FileCodeIcon className={className} data-icon-mode="code" />
    : <FileTextIcon className={className} data-icon-mode="text" />;
}
