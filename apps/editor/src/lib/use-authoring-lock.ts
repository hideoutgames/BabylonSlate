import { useSyncExternalStore } from "react";
import { useDocumentActions } from "../context/document-context";

/** Only lock transitions rerender consumers; no runtime values enter this store. */
export function useAuthoringLock() {
  const { subscribeAuthoringLock, getAuthoringLock } = useDocumentActions();
  return useSyncExternalStore(subscribeAuthoringLock, getAuthoringLock, getAuthoringLock);
}
