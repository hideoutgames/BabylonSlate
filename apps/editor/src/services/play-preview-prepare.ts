export type PlayPreviewDirtyDoc = {
  label: string;
};

export type PlayPreviewPrepareInput = {
  dirtyDocuments: readonly PlayPreviewDirtyDoc[];
  scriptsStale: boolean;
};

export type PlayPreviewPreparePlan =
  | { action: "launch" }
  | {
      action: "prepare";
      needsSave: boolean;
      needsCompile: boolean;
      dirtyNames: string[];
    };

export function planPlayPreviewPrepare(
  input: PlayPreviewPrepareInput,
): PlayPreviewPreparePlan {
  const dirtyNames = input.dirtyDocuments.map((doc) => doc.label);
  const needsSave = dirtyNames.length > 0;
  const needsCompile = input.scriptsStale;

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
