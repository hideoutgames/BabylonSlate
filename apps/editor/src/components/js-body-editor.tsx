import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";

export type JsBodyEditorProps = {
  value: string;
  onChange: (value: string) => void;
  bodyLine?: number;
};

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
export function JsBodyEditor({ value, onChange, bodyLine }: JsBodyEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        javascript(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": {
            minHeight: "160px",
            fontSize: "14px",
          },
          ".cm-content": {
            caretColor: "var(--foreground)",
          },
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
    <div className="flex flex-col gap-2" data-testid="js-body-editor">
      <div
        ref={hostRef}
        className="overflow-hidden rounded-lg border border-border bg-card text-left [&_.cm-editor]:outline-none"
        // Selection intentionally enabled for code editing.
        style={{ userSelect: "text", WebkitUserSelect: "text" }}
      />
      <div className="flex flex-wrap gap-1" data-testid="js-accessory-bar">
        {ACCESSORY.map((token) => (
          <button
            key={token}
            type="button"
            className="min-h-11 min-w-11 rounded-md border border-border bg-secondary px-2 text-sm"
            onClick={() => insert(token)}
          >
            {token === "Tab" ? "⇥" : token}
          </button>
        ))}
      </div>
    </div>
  );
}
