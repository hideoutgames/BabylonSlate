import { runImportWorkerRequest, type ImportWorkerRequest } from "./import-worker-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// One request per worker: the editor terminates it after the reply, or at once to cancel.
scope.onmessage = (event) => {
  void runImportWorkerRequest(event.data, (reply, transfer = []) => scope.postMessage(reply, transfer));
};
