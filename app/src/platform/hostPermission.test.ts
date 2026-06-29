import { describe, it, expect } from 'vitest';
import { ensureHostPermission, originPatternFor, type PermissionsApi } from './hostPermission';

describe('originPatternFor', () => {
  it('derives an origin pattern from a URL with a path', () => {
    expect(originPatternFor('https://mcp.example.com/rpc')).toBe('https://mcp.example.com/*');
  });
  it('includes a non-default port', () => {
    expect(originPatternFor('http://localhost:3000/messages')).toBe('http://localhost:3000/*');
  });
});

describe('ensureHostPermission', () => {
  it('returns true without requesting when already granted', async () => {
    let requested = false;
    const api: PermissionsApi = {
      contains: () => Promise.resolve(true),
      request: () => {
        requested = true;
        return Promise.resolve(true);
      },
    };
    expect(await ensureHostPermission('https://a.example/rpc', api)).toBe(true);
    expect(requested).toBe(false);
  });

  it('requests permission when not yet held and returns the grant result', async () => {
    const seen: string[][] = [];
    const api: PermissionsApi = {
      contains: () => Promise.resolve(false),
      request: (p) => {
        seen.push(p.origins);
        return Promise.resolve(true);
      },
    };
    expect(await ensureHostPermission('https://b.example/rpc', api)).toBe(true);
    expect(seen).toEqual([['https://b.example/*']]);
  });

  it('returns false when the user denies the request', async () => {
    const api: PermissionsApi = { contains: () => Promise.resolve(false), request: () => Promise.resolve(false) };
    expect(await ensureHostPermission('https://c.example/rpc', api)).toBe(false);
  });
});
