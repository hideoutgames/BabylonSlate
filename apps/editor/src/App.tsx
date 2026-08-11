import { useSuppressNativeContextMenu } from "@babylonslate/editor-kit";
import { EditorChromeBar } from "./components/editor-chrome-bar";
import { DocumentWorkspace } from "./components/document-workspace";
import { DocumentProvider } from "./context/document-context";

function EditorLayout() {
  useSuppressNativeContextMenu();

  return (
    <div className="flex min-h-svh h-dvh flex-col bg-background text-foreground">
      <EditorChromeBar />
      <main className="flex min-h-0 flex-1 flex-col">
        <DocumentWorkspace />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <DocumentProvider>
      <EditorLayout />
    </DocumentProvider>
  );
}
