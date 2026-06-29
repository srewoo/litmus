import { describe, it, expect } from 'vitest';
import type { FetchInit, FetchResponse } from '../providers/types';
import { createTransport, McpTransportError } from './transport';
import { makeNotification, makeRequest } from './jsonrpc';
import type { McpServerConfig } from './types';

const SERVER: McpServerConfig = { id: 's1', name: 'demo', url: 'https://mcp.example/rpc', transport: 'http' };

function stream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

function jsonResponse(obj: unknown, headers: Record<string, string> = {}): FetchResponse {
  const body = JSON.stringify(obj);
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  return {
    ok: true,
    status: 200,
    body: stream(body),
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

function sseResponse(frames: readonly string[], headers: Record<string, string> = {}): FetchResponse {
  const text = frames.map((f) => `data: ${f}\n\n`).join('');
  const h: Record<string, string> = { 'content-type': 'text/event-stream', ...headers };
  return {
    ok: true,
    status: 200,
    body: stream(text),
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(text),
  };
}

describe('HttpTransport.request', () => {
  it('reads a single JSON response and sets standard headers', async () => {
    let captured: { url: string; init: FetchInit } | null = null;
    const fetchImpl = async (url: string, init: FetchInit) => {
      captured = { url, init };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    };
    const t = createTransport(SERVER, { fetchImpl, protocolVersion: '2025-06-18' });
    const res = await t.request(makeRequest(1, 'ping'));
    expect(res.result).toEqual({ ok: true });
    expect(captured!.url).toBe(SERVER.url);
    expect(captured!.init.headers['content-type']).toBe('application/json');
    expect(captured!.init.headers['accept']).toContain('text/event-stream');
    expect(captured!.init.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('picks the matching id out of an SSE response stream', async () => {
    const fetchImpl = async () =>
      sseResponse([
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 7, result: { matched: true } }),
      ]);
    const t = createTransport(SERVER, { fetchImpl });
    const res = await t.request(makeRequest(7, 'tools/list'));
    expect(res.result).toEqual({ matched: true });
  });

  it('captures Mcp-Session-Id and echoes it on the next request', async () => {
    const seen: string[] = [];
    const fetchImpl = async (_url: string, init: FetchInit) => {
      seen.push(init.headers['mcp-session-id'] ?? '');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'abc' });
    };
    const t = createTransport(SERVER, { fetchImpl });
    await t.request(makeRequest(1, 'initialize'));
    await t.request(makeRequest(2, 'tools/list'));
    expect(t.sessionId).toBe('abc');
    expect(seen).toEqual(['', 'abc']); // first had none, second echoed it
  });

  it('sends the Authorization header when configured', async () => {
    let auth = '';
    const fetchImpl = async (_url: string, init: FetchInit) => {
      auth = init.headers['authorization'] ?? '';
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
    };
    const t = createTransport({ ...SERVER, authHeader: 'Bearer xyz' }, { fetchImpl });
    await t.request(makeRequest(1, 'ping'));
    expect(auth).toBe('Bearer xyz');
  });

  it('throws McpTransportError on a non-OK HTTP status', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: false,
      status: 500,
      body: null,
      headers: { get: () => null },
      text: () => Promise.resolve('upstream error'),
    });
    const t = createTransport(SERVER, { fetchImpl });
    await expect(t.request(makeRequest(1, 'ping'))).rejects.toBeInstanceOf(McpTransportError);
  });

  it('forces an SSE-only Accept header for the sse transport kind', async () => {
    let accept = '';
    const fetchImpl = async (_url: string, init: FetchInit) => {
      accept = init.headers['accept'] ?? '';
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
    };
    const t = createTransport({ ...SERVER, transport: 'sse' }, { fetchImpl });
    await t.request(makeRequest(1, 'ping'));
    expect(accept).toBe('text/event-stream');
  });
});

describe('HttpTransport.notify', () => {
  it('posts the notification body and does not require a response', async () => {
    let body = '';
    const fetchImpl = async (_url: string, init: FetchInit) => {
      body = init.body ?? '';
      return { ok: true, status: 202, body: null, headers: { get: () => null }, text: () => Promise.resolve('') };
    };
    const t = createTransport(SERVER, { fetchImpl });
    await t.notify(makeNotification('notifications/initialized'));
    expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });
});
