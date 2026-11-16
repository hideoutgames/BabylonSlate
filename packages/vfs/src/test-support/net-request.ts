import { EventEmitter } from "node:events";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { TransferClientRequest, TransferRequest, TransferRequestOptions } from "../node-file-transfer";

/** Headers Electron refuses from an app; a request that sets one fails (`net::ERR_INVALID_ARGUMENT`). */
const RESTRICTED = new Set(["content-length", "host", "trailer", "te", "upgrade", "cookie2", "keep-alive", "transfer-encoding"]);

/**
 * A stand-in for Electron's `net.request` (`ClientRequest`) over Node's
 * `http`, keeping the behaviour a transfer depends on, as Electron 44 has it:
 * a body written without `chunkedEncoding` is collected and sent with its
 * length (`SlurpStream`), and with it is streamed chunked; a restricted
 * header (`Content-Length`, `Transfer-Encoding`, …) fails the request;
 * `redirect: "error"` fails on a 3xx; `abort()` stops it. `route` maps a
 * URL to the loopback address that serves it.
 */
export function netRequest(route: (url: string) => string = (url) => url): TransferRequest {
  return (options) => new NetRequest(options, route(options.url));
}

class NetRequest extends EventEmitter implements TransferClientRequest {
  chunkedEncoding = false;
  private readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private started: ClientRequest | null = null;
  private refused = false;
  private aborted = false;

  constructor(
    private readonly options: TransferRequestOptions,
    private readonly target: string,
  ) {
    super();
  }

  /** Electron's listeners are typed per event; this stand-in takes them as the transfer declares them. */
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as unknown as (...args: unknown[]) => void);
  }

  setHeader(name: string, value: string): void {
    if (this.started || this.chunks.length > 0) throw new Error("Can't set headers after they are sent");
    if (RESTRICTED.has(name.toLowerCase())) this.refused = true;
    this.headers[name] = value;
  }

  write(chunk: Buffer, _encoding: undefined, callback: () => void): void {
    if (this.chunkedEncoding) {
      this.start().write(chunk, () => callback());
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  }

  end(): void {
    if (this.chunkedEncoding) {
      this.start().end();
      return;
    }
    const body = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    const request = this.start(body.byteLength);
    request.end(body);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.started?.destroy();
    this.emit("abort");
  }

  private start(length?: number): ClientRequest {
    if (this.started) return this.started;
    const request = httpRequest(this.target, {
      method: this.options.method,
      headers: { ...this.headers, ...(length !== undefined && this.options.method !== "GET" ? { "Content-Length": String(length) } : {}) },
    });
    this.started = request;
    if (this.refused) {
      request.destroy();
      setImmediate(() => this.emit("error", new Error("net::ERR_INVALID_ARGUMENT")));
      return request;
    }
    request.on("response", (response: IncomingMessage) => {
      if (this.aborted) return;
      if (this.options.redirect === "error" && (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy();
        this.emit("error", new Error("net::ERR_ABORTED: redirect was refused"));
        return;
      }
      this.emit("response", Object.assign(response, { statusCode: response.statusCode ?? 0 }));
    });
    request.on("error", (error) => {
      if (!this.aborted) this.emit("error", error);
    });
    return request;
  }
}
