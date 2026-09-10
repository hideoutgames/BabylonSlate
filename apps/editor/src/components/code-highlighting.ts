import { StreamLanguage } from "@codemirror/language";
import { shader } from "@codemirror/legacy-modes/mode/clike";
import { tags, tagHighlighter } from "@lezer/highlight";

export const glslLanguage = StreamLanguage.define(shader);
export const codeHighlight = tagHighlighter([
  { tag: [tags.keyword, tags.typeName], class: "text-[var(--pin-string)]" },
  { tag: tags.comment, class: "text-muted-foreground italic" },
  { tag: [tags.number, tags.bool], class: "text-[var(--pin-float)]" },
  { tag: tags.string, class: "text-[var(--pin-string)]" },
  { tag: tags.function(tags.variableName), class: "text-[var(--pin-vector)]" },
]);
