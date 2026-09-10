import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { Button } from "@babylonslate/ui/components/button";
import { codeHighlight, glslLanguage } from "./code-highlighting";
import { autocompletion, closeCompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { codeCompletions } from "./code-completion";

export type JsBodyEditorProps = {
  value: string;
  onChange: (value: string) => void;
  bodyLine?: number;
  names?: readonly string[];
};

export function JsBodyEditor(props: JsBodyEditorProps) {
  return <CodeBodyEditor {...props} language="javascript" />;
}

const ACCESSORY = [
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  "'",
  '"',
  "=",
  "<",
  ">",
  "Tab",
] as const;

/**
 * Touch-friendly ExecuteJavaScript body editor (CodeMirror 6).
 * Loaded only when the Details panel needs it.
 */
export function CodeBodyEditor({ value, onChange, bodyLine, language, names = [] }: JsBodyEditorProps & { language: "javascript" | "glsl" }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const namesRef = useRef(names);
  namesRef.current = names;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        language === "glsl" ? glslLanguage : javascript(),
        syntaxHighlighting(codeHighlight),
        bracketMatching(),
        autocompletion(),
        (language === "glsl" ? glslLanguage : javascript().language).data.of({ autocomplete: (context: import("@codemirror/autocomplete").CompletionContext) => codeCompletions(context, language, namesRef.current) }),
        EditorView.contentAttributes.of({ "aria-label": language === "glsl" ? "GLSL Function Body" : "JavaScript Function Body" }),
        keymap.of([{ key: "Escape", run: closeCompletion, stopPropagation: true }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "12px",
            backgroundColor: "var(--background)",
            color: "var(--foreground)",
          },
          ".cm-content": {
            caretColor: "var(--foreground)",
            padding: "8px 0",
          },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", lineHeight: "1.6" },
          ".cm-gutters": { backgroundColor: "var(--sidebar)", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" },
          ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)" },
          ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent)" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; external value sync handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || bodyLine == null || bodyLine < 1) return;
    const line = view.state.doc.line(Math.min(bodyLine, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }, [bodyLine]);

  const insert = (token: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (token === "Tab") {
      view.dispatch(view.state.replaceSelection("  "));
      return;
    }
    view.dispatch(view.state.replaceSelection(token));
    view.focus();
  };

  return (
    <div className="flex min-h-40 flex-1 flex-col" data-testid={language === "glsl" ? "glsl-body-editor" : "js-body-editor"}>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden text-left [&_.cm-editor]:outline-none"
        // Selection intentionally enabled for code editing.
        style={{ userSelect: "text", WebkitUserSelect: "text" }}
      />
      <div className="hidden flex-wrap gap-1 border-t p-1 [@media(pointer:coarse)]:flex" data-testid="js-accessory-bar">
        <Button type="button" variant="outline" size="touch" onPointerDown={(event) => event.preventDefault()} onClick={() => { if (viewRef.current) { viewRef.current.focus(); startCompletion(viewRef.current); } }}>Complete</Button>
        {ACCESSORY.map((token) => (
          <Button
            key={token}
            type="button"
            variant="outline"
            size="touch"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => insert(token)}
          >
            {token === "Tab" ? "⇥" : token}
          </Button>
        ))}
      </div>
      <div className="flex shrink-0 justify-between border-t bg-sidebar px-2 py-1 text-xs text-muted-foreground"><span>{language === "glsl" ? "GLSL" : "JavaScript"}</span><span>Ctrl+Space: Complete · Enter: Accept · Esc: Dismiss</span></div>
    </div>
  );
}
