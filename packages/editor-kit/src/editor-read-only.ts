import { createContext, useContext } from "react";

/** Presentation policy only; authoring owners must independently reject writes. */
export const EditorReadOnlyContext = createContext(false);
export const useEditorReadOnly = () => useContext(EditorReadOnlyContext);
