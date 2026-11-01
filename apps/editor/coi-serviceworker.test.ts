import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  "apps/editor/public/coi-serviceworker.js",
  "utf8",
);

function controller() {
  return { postMessage: vi.fn() };
}

/** Execute the shipped script; only the browser's worker lifecycle is controlled. */
function bootstrap() {
  const registration = Object.assign(new EventTarget(), {
    active: null as ReturnType<typeof controller> | null,
    scope: "https://editor.example/",
  });
  let resolveRegistration!: (value: typeof registration) => void;
  let rejectRegistration!: (error: Error) => void;
  const registered = new Promise<typeof registration>((resolve, reject) => {
    resolveRegistration = resolve;
    rejectRegistration = reject;
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: null as ReturnType<typeof controller> | null,
    register: vi.fn(() => registered),
  });
  const reload = vi.fn();
  const window = {
    crossOriginIsolated: false,
    isSecureContext: true,
    chrome: {},
    document: { currentScript: { src: "https://editor.example/coi-serviceworker.js" } },
    location: { reload },
    coi: {
      shouldRegister: () => true,
      shouldDeregister: () => false,
    },
  };
  const console = { log: vi.fn(), error: vi.fn() };
  return {
    registration,
    serviceWorker,
    window,
    reload,
    console,
    start: () => runInNewContext(source, { window, navigator: { serviceWorker }, console }),
    async registered() {
      resolveRegistration(registration);
      await registered;
    },
    async failed(error: Error) {
      rejectRegistration(error);
      await registered.catch(() => {});
    },
  };
}

describe("COI service worker bootstrap", () => {
  it("waits for a controlling worker instead of reloading during installation", async () => {
    const app = bootstrap();
    app.start();
    await app.registered();
    app.registration.dispatchEvent(new Event("updatefound"));
    expect(app.reload).not.toHaveBeenCalled();

    app.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(app.reload).not.toHaveBeenCalled();
    app.serviceWorker.controller = controller();
    app.serviceWorker.dispatchEvent(new Event("controllerchange"));
    app.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(app.reload).toHaveBeenCalledTimes(1);
  });

  it("observes worker control acquired before registration resolves", async () => {
    const app = bootstrap();
    app.serviceWorker.register.mockImplementation(() => {
      app.serviceWorker.controller = controller();
      app.serviceWorker.dispatchEvent(new Event("controllerchange"));
      return Promise.resolve(app.registration);
    });
    app.start();
    await Promise.resolve();
    expect(app.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads an uncontrolled document when registration is already active", async () => {
    const app = bootstrap();
    app.registration.active = controller();
    app.start();
    await app.registered();
    expect(app.reload).toHaveBeenCalledTimes(1);

    app.serviceWorker.controller = app.registration.active;
    app.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(app.reload).toHaveBeenCalledTimes(1);
  });

  it("does not loop reloads when a controlled document remains nonisolated", async () => {
    const app = bootstrap();
    app.serviceWorker.controller = controller();
    app.registration.active = app.serviceWorker.controller;
    app.start();
    await app.registered();
    expect(app.reload).not.toHaveBeenCalled();
    expect(app.serviceWorker.controller.postMessage).toHaveBeenCalledWith({
      type: "coepCredentialless",
      value: false,
    });
  });

  it("removes the control listener when registration fails", async () => {
    const app = bootstrap();
    app.start();
    const error = new Error("Worker registration rejected");
    await app.failed(error);
    app.serviceWorker.controller = controller();
    app.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(app.reload).not.toHaveBeenCalled();
    expect(app.console.error).toHaveBeenCalledWith(
      "COOP/COEP Service Worker failed to register:",
      error,
    );
  });

  it.each(["insecure", "isolated", "disabled"] as const)(
    "leaves an %s page outside the bootstrap lifecycle",
    (state) => {
      const app = bootstrap();
      if (state === "insecure") app.window.isSecureContext = false;
      if (state === "isolated") app.window.crossOriginIsolated = true;
      if (state === "disabled") app.window.coi.shouldRegister = () => false;
      app.start();
      app.serviceWorker.controller = controller();
      app.serviceWorker.dispatchEvent(new Event("controllerchange"));
      expect(app.serviceWorker.register).not.toHaveBeenCalled();
      expect(app.reload).not.toHaveBeenCalled();
    },
  );

  it("preserves deregistration messages for an already-isolated page", () => {
    const app = bootstrap();
    app.window.crossOriginIsolated = true;
    app.window.coi.shouldDeregister = () => true;
    app.serviceWorker.controller = controller();
    app.start();
    expect(app.serviceWorker.controller.postMessage).toHaveBeenCalledWith({
      type: "deregister",
    });
    expect(app.serviceWorker.register).not.toHaveBeenCalled();
    expect(app.reload).not.toHaveBeenCalled();
  });
});

/** Execute the shipped script as the service worker; only the network (`fetch`) is controlled. */
function isolationWorker(network: () => Promise<unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const console = { error: vi.fn() };
  runInNewContext(source, { self, fetch: network, Request, Response, Headers, console });
  return {
    console,
    /** Dispatch a fetch event and resolve to the worker's answer (undefined when it answers with nothing). */
    fetch(url: string): Promise<Response | undefined> {
      let answer: Promise<Response | undefined> = Promise.resolve(undefined);
      listeners.get("fetch")?.({
        request: new Request(url),
        respondWith: (value: Promise<Response | undefined>) => { answer = value; },
      });
      return answer;
    },
  };
}

describe("COI service worker fetch", () => {
  it.each([304, 204])("forwards a %i that arrives with an empty body stream, with the isolation headers", async (status) => {
    // WebKit answers a revalidated module worker script this way; wrapping its body failed the worker's load.
    const worker = isolationWorker(async () => ({
      status,
      statusText: "",
      headers: new Headers({ etag: '"a"' }),
      body: new ReadableStream(),
    }));
    const response = await worker.fetch("https://editor.example/assets/worker-entry.js");
    expect(response?.status).toBe(status);
    expect(response?.headers.get("etag")).toBe('"a"');
    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(worker.console.error).not.toHaveBeenCalled();
  });

  it("keeps the body of an ordinary response", async () => {
    const worker = isolationWorker(async () =>
      new Response("export {};", { status: 200, headers: { "content-type": "text/javascript" } }));
    const response = await worker.fetch("https://editor.example/assets/worker-entry.js");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("export {};");
    expect(response?.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });
});
