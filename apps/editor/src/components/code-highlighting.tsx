import { StreamLanguage } from "@codemirror/language";
import { shader } from "@codemirror/legacy-modes/mode/clike";
import { highlightTree, tags, tagHighlighter } from "@lezer/highlight";
import type { ReactNode } from "react";

export const glslLanguage = StreamLanguage.define(shader);
export const codeHighlight = tagHighlighter([
  { tag: [tags.keyword, tags.typeName], class: "text-primary" },
  { tag: tags.comment, class: "text-muted-foreground italic" },
  { tag: [tags.number, tags.bool], class: "text-[var(--pin-float)]" },
  { tag: tags.string, class: "text-[var(--pin-string)]" },
  { tag: tags.function(tags.variableName), class: "text-[var(--pin-vector)]" },
]);

/** Static spans: graph nodes never allocate an editable CodeMirror view. */
export function GlslCodePreview({ value }: { value: string }) {
  const code = value.split("\n").slice(0, 4).join("\n");
  const spans: ReactNode[] = [];
  let offset = 0;
  highlightTree(glslLanguage.parser.parse(code), codeHighlight, (from, to, className) => {
    if (from > offset) spans.push(code.slice(offset, from));
    spans.push(<span key={from} className={className}>{code.slice(from, to)}</span>);
    offset = to;
  });
  spans.push(code.slice(offset));
  return <pre className="m-0 w-full overflow-hidden whitespace-pre text-left font-mono text-xs leading-5" data-testid="glsl-code-preview"><code>{spans}</code></pre>;
}
