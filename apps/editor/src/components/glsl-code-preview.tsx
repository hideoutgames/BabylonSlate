import { highlightTree } from "@lezer/highlight";
import type { ReactNode } from "react";
import { codeHighlight, glslLanguage } from "./code-highlighting";
import { javascriptLanguage } from "@codemirror/lang-javascript";

/** Static spans: graph nodes never allocate an editable CodeMirror view. */
export function GlslCodePreview({ value, language = "glsl" }: { value: string; language?: "glsl" | "javascript" }) {
  const code = value.split("\n").slice(0, 4).join("\n");
  const spans: ReactNode[] = [];
  let offset = 0;
  highlightTree((language === "glsl" ? glslLanguage : javascriptLanguage).parser.parse(code), codeHighlight, (from, to, className) => {
    if (from > offset) spans.push(code.slice(offset, from));
    spans.push(<span key={from} className={className}>{code.slice(from, to)}</span>);
    offset = to;
  });
  spans.push(code.slice(offset));
  return <pre className="m-0 w-full overflow-hidden whitespace-pre text-left font-mono text-xs leading-5" data-testid={language === "glsl" ? "glsl-code-preview" : "js-code-preview"}><code>{spans}</code></pre>;
}
