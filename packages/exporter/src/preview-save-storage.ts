import {
  createSaveStorageClient,
  createSaveStorageServer,
  newGuid,
  type SaveGameStorage,
  type SaveStorageRequest,
  type SaveStorageResponse,
} from "@babylonslate/core";

const CHANNEL = "babylonslate-preview-save-storage";
type PreviewSaveMessage = {
  type: typeof CHANNEL;
  session: string;
  action: "open" | "close" | "request" | "response";
  request?: SaveStorageRequest;
  response?: SaveStorageResponse;
};
type IncomingMessage = { source: unknown; origin: string; data: unknown };
interface Endpoint {
  source(): unknown;
  origin(): string;
  send(message: PreviewSaveMessage): void;
}

function trustedMessage(event: IncomingMessage, endpoint: Endpoint): PreviewSaveMessage | null {
  if (!endpoint.source() || event.source !== endpoint.source() || event.origin !== endpoint.origin()) return null;
  const data = event.data as Partial<PreviewSaveMessage> | null;
  return data && data.type === CHANNEL && typeof data.session === "string" && data.session.length > 0 && data.session.length <= 128 &&
    ["open", "close", "request", "response"].includes(String(data.action)) ? data as PreviewSaveMessage : null;
}

/** A Preview iframe uses its parent's native/browser store, never its own host detection. */
export function createPreviewSaveStorageClient(endpoint: Endpoint) {
  const session = newGuid();
  const client = createSaveStorageClient((request) => endpoint.send({ type: CHANNEL, session, action: "request", request }));
  endpoint.send({ type: CHANNEL, session, action: "open" });
  return {
    storage: client.storage,
    receive(event: IncomingMessage): void {
      const message = trustedMessage(event, endpoint);
      if (message?.session === session && message.action === "response" && message.response) client.receive(message.response);
    },
    dispose(): void {
      client.dispose();
      endpoint.send({ type: CHANNEL, session, action: "close" });
    },
  };
}

/** The host grants only this project's preview namespace and retires reloads/Stop. */
export function createPreviewSaveStorageHost(storage: SaveGameStorage, projectId: string, endpoint: Endpoint) {
  const root = `save-games/${encodeURIComponent(projectId)}/preview`;
  let session: string | null = null;
  let server: ReturnType<typeof createSaveStorageServer> | null = null;
  let closed = false;
  const reply = (response: SaveStorageResponse, owner = session) => {
    if (!closed && owner && owner === session) endpoint.send({ type: CHANNEL, session: owner, action: "response", response });
  };
  return {
    receive(event: IncomingMessage): void {
      if (closed) return;
      const message = trustedMessage(event, endpoint);
      if (!message) return;
      if (message.action === "open") {
        if (message.session === session) return;
        server?.dispose();
        session = message.session;
        server = createSaveStorageServer(storage, (response) => reply(response, message.session));
        return;
      }
      if (message.session !== session) return;
      if (message.action === "close") {
        server?.dispose(); server = null; session = null;
        return;
      }
      if (message.action !== "request" || !message.request) return;
      const request = message.request;
      const valid = Number.isSafeInteger(request.id) && request.id > 0 && typeof request.key === "string" &&
        ["read", "write", "remove", "list", "acquire", "release", "persist"].includes(request.operation) &&
        (request.operation !== "write" || typeof request.text === "string");
      const safeKey = valid && !request.key.includes("\\") && !request.key.includes("\0") &&
        !request.key.split("/").some((part) => part === "." || part === "..");
      const inScope = valid && (request.operation === "persist" || request.operation === "release" ||
        (safeKey && (request.operation === "acquire" ? request.key === root : request.key.startsWith(`${root}/`))));
      if (!valid || !inScope) {
        reply({ id: request.id, error: { name: "Error", message: "Preview save request is outside this project's preview storage." } });
        return;
      }
      server?.receive(request);
    },
    dispose(): void {
      closed = true;
      server?.dispose(); server = null; session = null;
    },
  };
}
