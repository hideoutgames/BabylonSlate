import { createAssetDiffHandler, type AssetDiffRequestMessage } from "./asset-diff-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AssetDiffRequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// The Source Control tab's diffs, decoded and compared off the main thread. Long-lived: it keeps
// the decoded versions of commits for the next diff.
const handle = createAssetDiffHandler((message, transfer = []) => scope.postMessage(message, transfer));
scope.onmessage = (event) => handle(event.data);
