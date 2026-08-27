export type PlayPreviewDirtyDoc = {
  label: string;
};

export type PlayPreviewPrepareInput = {
  dirtyDocuments: readonly PlayPreviewDirtyDoc[];
  scriptsStale: boolean;
  migrationPending: boolean;
};

export type PlayPreviewPreparePlan =
  | { action: "launch" }
  | { action: "migrate" }
  | {
      action: "prepare";
      needsSave: boolean;
      needsCompile: boolean;
      dirtyNames: string[];
    };

export type PlayBundlesNeedCollectInput = {
  playLoadedSignature: string | null;
  currentGraphSignature: string;
  scriptsLength: number;
  /**
   * Editor Compile / compile-on-save fingerprint. Must not control Play skip —
   * those paths can mark graphs current without writing Play's bundle array.
   */
  editorCompileSignature?: string | null;
};

/** True when Play must run `collectPlayPreviewScripts` instead of reusing stored bundles. */
export function playBundlesNeedCollect(
  input: PlayBundlesNeedCollectInput,
): boolean {
  void input.editorCompileSignature;
  if (input.scriptsLength === 0 || input.playLoadedSignature === null) {
    return true;
  }
  return input.playLoadedSignature !== input.currentGraphSignature;
}

export function planPlayPreviewPrepare(
  input: PlayPreviewPrepareInput,
): PlayPreviewPreparePlan {
  const dirtyNames = input.dirtyDocuments.map((doc) => doc.label);
  const needsSave = dirtyNames.length > 0;
  const needsCompile = input.scriptsStale;

  if (needsSave && input.migrationPending) {
    return { action: "migrate" };
  }
  if (!needsSave && !needsCompile) {
    return { action: "launch" };
  }
  return {
    action: "prepare",
    needsSave,
    needsCompile,
    dirtyNames,
  };
}
