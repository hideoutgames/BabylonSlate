import { lazy, Suspense } from "react";
import type { JsBodyEditorProps } from "./js-body-editor";
import { codePreviewText } from "./code-preview-text";

// CodeMirror and Lezer load with the first code body a screen shows, never with the editor route.
const CodeBodyEditor = lazy(() => import("./js-body-editor").then((module) => ({ default: module.CodeBodyEditor })));
const GlslCodePreview = lazy(() => import("./glsl-code-preview").then((module) => ({ default: module.GlslCodePreview })));

type CodeBodyEditorProps = JsBodyEditorProps & { language: "javascript" | "glsl" };

/** The CodeMirror code editor; its code shows read-only while CodeMirror loads. */
export function LazyCodeBodyEditor(props: CodeBodyEditorProps) {
  return (
    <Suspense fallback={(
      <div className="flex min-h-40 flex-1 flex-col" aria-busy="true">
        <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre px-2 py-2 text-left font-mono text-xs leading-5 text-muted-foreground">{props.value}</pre>
      </div>
    )}>
      <CodeBodyEditor {...props} />
    </Suspense>
  );
}

export function LazyJsBodyEditor(props: JsBodyEditorProps) {
  return <LazyCodeBodyEditor {...props} language="javascript" />;
}

/** The highlighted node-body preview; plain text until the highlighter loads. */
export function LazyGlslCodePreview(props: { value: string; language?: "glsl" | "javascript" }) {
  return (
    <Suspense fallback={(
      <pre className="m-0 w-full overflow-hidden whitespace-pre text-left font-mono text-xs leading-5"><code>{codePreviewText(props.value)}</code></pre>
    )}>
      <GlslCodePreview {...props} />
    </Suspense>
  );
}
