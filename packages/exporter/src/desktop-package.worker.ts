import { runDesktopPackage, type DesktopPackageReply, type DesktopPackageRequest } from "./desktop-package-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DesktopPackageRequest>) => void) | null;
  postMessage(message: DesktopPackageReply, transfer?: Transferable[]): void;
};

// One request per worker: the client terminates it once the reply arrives.
scope.onmessage = async (event) => {
  try {
    const { fileName, bytes } = await runDesktopPackage(event.data);
    // Nothing here keeps the package, so its buffer moves to the editor.
    scope.postMessage({ ok: true, fileName, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
