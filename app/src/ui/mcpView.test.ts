import { describe, it, expect } from 'vitest';
import {
  batchFieldFor,
  batchResultsHtml,
  capabilitiesHtml,
  conformancePillHtml,
  connectionBarHtml,
  findingsHtml,
  securityReportHtml,
  toolFormHtml,
  toolListHtml,
} from './mcpView';
import type { ConformanceReport } from '../mcp/conformance';
import type { McpToolDescriptor } from '../mcp/types';
import type { SecurityReport } from '../mcp/security';

const report = (over: Partial<ConformanceReport> = {}): ConformanceReport => ({
  ok: true,
  handshake: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: true, resources: false, prompts: false },
    serverInfo: { name: 'demo', version: '1.0.0' },
  },
  toolCount: 2,
  resourceCount: 0,
  promptCount: 0,
  findings: [{ level: 'pass', check: 'handshake', detail: 'ok' }],
  ...over,
});

describe('capabilitiesHtml', () => {
  it('shows server info and only advertised capabilities with counts', () => {
    const html = capabilitiesHtml(report());
    expect(html).toContain('demo');
    expect(html).toContain('tools (2)');
    expect(html).not.toContain('resources');
  });
  it('escapes a malicious server name', () => {
    const html = capabilitiesHtml(
      report({ handshake: { protocolVersion: 'v', capabilities: { tools: false, resources: false, prompts: false }, serverInfo: { name: '<script>x</script>', version: '1' } } }),
    );
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('findingsHtml', () => {
  it('orders fail before warn before pass', () => {
    const html = findingsHtml([
      { level: 'pass', check: 'a', detail: 'x' },
      { level: 'fail', check: 'b', detail: 'y' },
      { level: 'warn', check: 'c', detail: 'z' },
    ]);
    expect(html.indexOf('fail')).toBeLessThan(html.indexOf('warn'));
    expect(html.indexOf('warn')).toBeLessThan(html.lastIndexOf('pass'));
  });
});

describe('toolListHtml', () => {
  it('renders clickable rows carrying the tool name', () => {
    const html = toolListHtml([{ name: 'get_weather', description: 'd', inputSchema: { type: 'object' } }]);
    expect(html).toContain('data-tool="get_weather"');
  });
  it('shows an empty state', () => {
    expect(toolListHtml([])).toContain('No tools');
  });
});

describe('connectionBarHtml', () => {
  it('shows identity and a live warning when connected', () => {
    const html = connectionBarHtml('connected', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: true, resources: false, prompts: false },
      serverInfo: { name: 'acme', version: '1.2' },
    });
    expect(html).toContain('acme');
    expect(html).toContain('⚠ live');
    expect(html).toContain('mcp-dot connected');
  });
  it('shows a spinner while connecting and an error message on error', () => {
    expect(connectionBarHtml('connecting')).toContain('spinner');
    expect(connectionBarHtml('error', undefined, 'boom')).toContain('boom');
  });
});

describe('conformancePillHtml', () => {
  it('auto-opens the disclosure when there is a failure', () => {
    const r = report({ ok: false, findings: [{ level: 'fail', check: 'prompts', detail: 'x' }] });
    const html = conformancePillHtml(r);
    expect(html).toContain('<details');
    expect(html).toContain(' open');
    expect(html).toContain('1 fail');
  });
  it('stays collapsed when only passes', () => {
    const html = conformancePillHtml(report({ findings: [{ level: 'pass', check: 'h', detail: 'ok' }] }));
    expect(html).not.toContain(' open>');
  });
});

describe('toolFormHtml', () => {
  const tool: McpToolDescriptor = {
    name: 'create_issue',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        priority: { enum: ['low', 'high'] },
        notify: { type: 'boolean' },
        count: { type: 'integer' },
        meta: { type: 'object' },
      },
    },
  };
  it('renders a typed field per property tagged with data-arg/data-type', () => {
    const html = toolFormHtml(tool);
    expect(html).toContain('data-arg="title" data-type="string"');
    expect(html).toContain('data-type="enum"'); // priority → select
    expect(html).toContain('data-type="boolean"'); // notify → checkbox
    expect(html).toContain('data-type="number"'); // count
    expect(html).toContain('data-type="json"'); // meta (object) → raw fallback field
  });
  it('marks required fields and carries the call button + raw toggle', () => {
    const html = toolFormHtml(tool);
    expect(html).toContain('class="req"'); // title is required
    expect(html).toContain('id="mcpCallBtn"');
    expect(html).toContain('id="mcpRawToggle"');
  });
  it('handles a tool with no declared parameters', () => {
    expect(toolFormHtml({ name: 'ping', inputSchema: { type: 'object' } })).toContain('No declared parameters');
  });
});

describe('batchFieldFor', () => {
  it('picks the required string field to vary', () => {
    const tool = { name: 'ask', inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, repo: { type: 'string' } } } };
    expect(batchFieldFor(tool)).toEqual({ name: 'question', mode: 'value' });
  });
  it('falls back to the first string field when none are required', () => {
    const tool = { name: 't', inputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } } } };
    expect(batchFieldFor(tool)).toEqual({ name: 'q', mode: 'value' });
  });
  it('uses JSON mode when the tool has no string field', () => {
    const tool = { name: 't', inputSchema: { type: 'object', properties: { n: { type: 'integer' } } } };
    expect(batchFieldFor(tool)).toEqual({ name: '', mode: 'json' });
  });
  it('varies the content field, not the first required string (the ask_question bug)', () => {
    // ask_question(repoName, question): both required, repoName declared first.
    const tool = { name: 'ask_question', inputSchema: { type: 'object', required: ['repoName', 'question'], properties: { repoName: { type: 'string' }, question: { type: 'string' } } } };
    expect(batchFieldFor(tool)).toEqual({ name: 'question', mode: 'value' });
  });
});

describe('toolFormHtml batch field selector', () => {
  const askQuestion = { name: 'ask_question', inputSchema: { type: 'object', required: ['repoName', 'question'], properties: { repoName: { type: 'string' }, question: { type: 'string' } } } };
  it('offers a vary-field selector for a multi-string tool, defaulting to the content field', () => {
    const html = toolFormHtml(askQuestion);
    expect(html).toContain('id="mcpBatchField"');
    expect(html).toContain('<option value="repoName">');
    expect(html).toContain('<option value="question" selected>');
    expect(html).toContain('other args in the form above');
  });
  it('omits the selector for a single-string tool', () => {
    const html = toolFormHtml({ name: 'q', inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } } });
    expect(html).not.toContain('id="mcpBatchField"');
  });
});

describe('toolFormHtml batch section', () => {
  it('renders the batch input + run button with field/mode data attributes', () => {
    const html = toolFormHtml({ name: 'ask', inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } } });
    expect(html).toContain('id="mcpBatchInput"');
    expect(html).toContain('id="mcpBatchBtn"');
    expect(html).toContain('data-field="question"');
    expect(html).toContain('data-mode="value"');
    expect(html).toContain('up to 10, 5 at a time');
  });
});

describe('batchResultsHtml', () => {
  it('summarizes ok/failed counts and lists each input', () => {
    const html = batchResultsHtml([
      { input: 'q1', ok: true, text: 'answer 1' },
      { input: 'q2', ok: false, text: 'boom' },
    ]);
    expect(html).toContain('1 ok');
    expect(html).toContain('1 failed');
    expect(html).toContain('q1');
    expect(html).toContain('q2');
    expect(html).toContain('answer 1');
  });
  it('returns empty string for no results', () => {
    expect(batchResultsHtml([])).toBe('');
  });
  it('escapes input and output', () => {
    const html = batchResultsHtml([{ input: '<b>x</b>', ok: true, text: '<script>y</script>' }]);
    expect(html).not.toContain('<script>y');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('securityReportHtml', () => {
  const secReport = (over: Partial<SecurityReport> = {}): SecurityReport => ({
    counts: { rejected: 5, 'accepted-invalid': 0, 'server-error': 0, 'possible-leak': 0 },
    findings: [],
    notes: [],
    ...over,
  });
  it('shows the all-clear message when nothing notable', () => {
    expect(securityReportHtml(secReport())).toContain('No issues found');
  });
  it('lists a high-severity leak finding', () => {
    const html = securityReportHtml(
      secReport({
        counts: { rejected: 4, 'accepted-invalid': 0, 'server-error': 0, 'possible-leak': 1 },
        findings: [
          {
            probe: { kind: 'injection', toolName: 'read', args: {}, description: 'traversal' },
            classification: 'possible-leak',
            severity: 'high',
            detail: 'marker found',
          },
        ],
      }),
    );
    expect(html).toContain('possible leak');
    expect(html).toContain('marker found');
  });
});
