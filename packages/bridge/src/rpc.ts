export interface RpcRequest<P = unknown> {
  id: number;
  method: string;
  params: P;
}

export interface RpcSuccess<R = unknown> {
  id: number;
  result: R;
}

export interface RpcFailure {
  id: number;
  error: { message: string; code?: string };
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure;

export interface RpcTransport {
  post(message: RpcRequest): Promise<RpcResponse>;
}

export function createRpcHost(transport: RpcTransport) {
  let nextId = 1;
  return {
    async call<P, R>(method: string, params: P): Promise<R> {
      const id = nextId++;
      const response = await transport.post({ id, method, params });
      if ("error" in response && response.error) {
        throw new Error(response.error.message);
      }
      return (response as RpcSuccess<R>).result;
    },
  };
}

export type RpcHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

export async function handleRpcRequest(
  request: RpcRequest,
  handler: RpcHandler,
): Promise<RpcResponse> {
  try {
    const result = await handler(request.method, request.params);
    return { id: request.id, result };
  } catch (err) {
    return {
      id: request.id,
      error: {
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
