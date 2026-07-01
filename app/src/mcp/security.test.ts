import { describe, it, expect } from 'vitest';
import {
  classifyOutcome,
  generateProbes,
  INJECTION_PAYLOADS,
  runSecurityScan,
  type SecurityProbe,
  type ToolCaller,
} from './security';
import type { McpCallResult, McpToolDescriptor } from './types';

const WEATHER: McpToolDescriptor = {
  name: 'get_weather',
  description: 'w',
  inputSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } }, required: ['city'] },
};

describe('generateProbes', () => {
  it('produces empty-args, missing-required, type-fuzz, oversized and injection probes', () => {
    const { probes } = generateProbes(WEATHER);
    const kinds = new Set(probes.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['empty-args', 'missing-required', 'type-fuzz', 'oversized', 'injection']));
    expect(probes.filter((p) => p.kind === 'injection')).toHaveLength(INJECTION_PAYLOADS.length);
    // missing-required omits the required key
    const missing = probes.find((p) => p.kind === 'missing-required');
    expect(missing && (missing.args as Record<string, unknown>)['city']).toBeUndefined();
  });

  it('notes when a tool has no string input (no injection possible)', () => {
    const tool: McpToolDescriptor = { name: 'count', inputSchema: { type: 'object', properties: { n: { type: 'integer' } } } };
    const { probes, notes } = generateProbes(tool);
    expect(probes.some((p) => p.kind === 'injection')).toBe(false);
    expect(notes.join(' ')).toMatch(/no string input/);
  });
});

const probe = (over: Partial<SecurityProbe> = {}): SecurityProbe => ({
  kind: 'type-fuzz',
  toolName: 't',
  args: {},
  description: 'd',
  ...over,
});
const okResult = (text: string, isError = false): McpCallResult => ({ isError, text, content: [] });

describe('classifyOutcome', () => {
  it('flags a clean success on a schema-violating probe as accepted-invalid', () => {
    const f = classifyOutcome(probe(), { ok: true, result: okResult('done') });
    expect(f.classification).toBe('accepted-invalid');
    expect(f.severity).toBe('medium');
  });

  it('treats an isError result on a malformed probe as rejected (good)', () => {
    const f = classifyOutcome(probe(), { ok: true, result: okResult('bad input', true) });
    expect(f.classification).toBe('rejected');
  });

  it('flags a high-severity leak when output contains a sensitive marker', () => {
    const p = probe({ kind: 'injection', payload: '../../../../etc/passwd' });
    const f = classifyOutcome(p, { ok: true, result: okResult('root:x:0:0:root:/root:/bin/bash') });
    expect(f.classification).toBe('possible-leak');
    expect(f.severity).toBe('high');
  });

  it('flags a leak that appears only in a non-text (structured) content block', () => {
    // text is empty; the sensitive marker is buried in a json/resource block —
    // scanning result.text alone would miss it.
    const p = probe({ kind: 'injection', payload: '$(id)' });
    const structured: McpCallResult = {
      isError: false,
      text: '',
      content: [{ type: 'json', data: { stdout: 'uid=0(root) gid=0(root)' } }],
    };
    const f = classifyOutcome(p, { ok: true, result: structured });
    expect(f.classification).toBe('possible-leak');
    expect(f.severity).toBe('high');
  });

  it('flags reflected payload as a medium leak', () => {
    const p = probe({ kind: 'injection', payload: '<script>alert(1)</script>' });
    const f = classifyOutcome(p, { ok: true, result: okResult('you said <script>alert(1)</script>') });
    expect(f.classification).toBe('possible-leak');
    expect(f.severity).toBe('medium');
  });

  it('classifies a thrown call as server-error', () => {
    const f = classifyOutcome(probe(), { ok: false, error: 'socket hang up' });
    expect(f.classification).toBe('server-error');
  });
});

describe('runSecurityScan', () => {
  it('runs every probe and tallies classifications', async () => {
    // A server that rejects everything cleanly: best-case posture.
    const caller: ToolCaller = { callTool: () => Promise.resolve(okResult('rejected', true)) };
    const report = await runSecurityScan(caller, [WEATHER]);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.counts.rejected).toBe(report.findings.length);
    expect(report.counts['possible-leak']).toBe(0);
  });

  it('surfaces a leak when a vulnerable server echoes a traversal payload', async () => {
    const caller: ToolCaller = {
      callTool: (_n, args) => {
        const city = (args as Record<string, unknown>)['city'];
        // Vulnerable: returns /etc/passwd contents for the traversal payload.
        if (city === '../../../../etc/passwd') return Promise.resolve(okResult('root:x:0:0:root:/root:/bin/bash'));
        return Promise.resolve(okResult('ok'));
      },
    };
    const report = await runSecurityScan(caller, [WEATHER]);
    expect(report.counts['possible-leak']).toBeGreaterThanOrEqual(1);
    expect(report.findings.some((f) => f.severity === 'high')).toBe(true);
  });
});
