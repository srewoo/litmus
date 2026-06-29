/**
 * JSON-RPC 2.0 envelopes for MCP (spec uses JSON-RPC over the chosen transport).
 * Pure and dependency-free: builds request/notification objects and classifies a
 * parsed response as success or error. No I/O — the transport owns the wire.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/** Monotonic id source so each request on a connection is uniquely correlatable. */
export function createIdSource(): () => number {
  let n = 0;
  return () => (n += 1);
}

export function makeRequest(id: number, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params };
}

/** Narrow an unknown parsed value to a JSON-RPC response shape. */
export function isJsonRpcResponse(v: unknown): v is JsonRpcResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o['jsonrpc'] === '2.0' && 'id' in o && ('result' in o || 'error' in o);
}

/** Raised when a server returns a JSON-RPC error object for a request. */
export class JsonRpcCallError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: JsonRpcError,
  ) {
    super(`[${method}] JSON-RPC ${rpc.code}: ${rpc.message}`);
    this.name = 'JsonRpcCallError';
  }
}

/** Return the result of a response, or throw a JsonRpcCallError if it carried an error. */
export function unwrap(method: string, res: JsonRpcResponse): unknown {
  if (res.error) throw new JsonRpcCallError(method, res.error);
  return res.result;
}
