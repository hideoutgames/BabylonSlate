import { EditorToolbar } from "./components/editor-toolbar";
import { DocumentTabBar } from "./components/document-tab-bar";
import { DocumentWorkspace } from "./components/document-workspace";
import { DocumentProvider } from "./context/document-context";

function EditorLayout() {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <EditorToolbar />
      <DocumentTabBar />
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
