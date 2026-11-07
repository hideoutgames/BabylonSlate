import { memo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DocumentWorkspaceProvider, useDocumentWorkspace } from "./document-workspace-context";

afterEach(cleanup);

describe("DocumentWorkspaceProvider", () => {
  it("re-renders its consumers only when the document changes, not on every workspace render", () => {
    const renders: string[] = [];
    // Memoised like a dock panel's content: only the context can re-render it.
    const Consumer = memo(function Consumer() {
      const { documentId } = useDocumentWorkspace();
      renders.push(documentId);
      return <span data-testid="document">{documentId}</span>;
    });
    let setTick!: (tick: number) => void;
    let setDocument!: (id: string) => void;
    function Workspace() {
      const [tick, updateTick] = useState(0);
      const [documentId, updateDocument] = useState("scene:main");
      setTick = updateTick;
      setDocument = updateDocument;
      return <div data-tick={tick}><DocumentWorkspaceProvider documentId={documentId}><Consumer /></DocumentWorkspaceProvider></div>;
    }
    render(<Workspace />);
    expect(renders).toEqual(["scene:main"]);

    // A tab switch, save or Play change re-renders the workspace with the same document.
    act(() => setTick(1));
    act(() => setTick(2));
    expect(renders).toEqual(["scene:main"]);

    act(() => setDocument("scene:other"));
    expect(renders).toEqual(["scene:main", "scene:other"]);
    expect(screen.getByTestId("document").textContent).toBe("scene:other");
  });
});
