import { describe, it, expect } from 'vitest';
import {
  createIdSource,
  isJsonRpcResponse,
  JsonRpcCallError,
  makeNotification,
  makeRequest,
  unwrap,
} from './jsonrpc';

describe('createIdSource', () => {
  it('yields a monotonically increasing id', () => {
    const next = createIdSource();
    expect([next(), next(), next()]).toEqual([1, 2, 3]);
  });
});

describe('makeRequest / makeNotification', () => {
  it('omits params when undefined', () => {
    expect(makeRequest(1, 'ping')).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(makeNotification('notifications/initialized')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });
  it('includes params when present', () => {
    expect(makeRequest(2, 'tools/call', { name: 'x' })).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x' },
    });
  });
});

describe('isJsonRpcResponse', () => {
  it('accepts a result response and an error response', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(true);
  });
  it('rejects non-responses', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', method: 'ping' })).toBe(false);
    expect(isJsonRpcResponse(null)).toBe(false);
    expect(isJsonRpcResponse('nope')).toBe(false);
  });
});

describe('unwrap', () => {
  it('returns the result on success', () => {
    expect(unwrap('m', { jsonrpc: '2.0', id: 1, result: { ok: true } })).toEqual({ ok: true });
  });
  it('throws JsonRpcCallError on an error response', () => {
    expect(() => unwrap('tools/call', { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no method' } })).toThrow(
      JsonRpcCallError,
    );
  });
});
