import { describe, it, expect } from 'vitest';
import { accumulateToolDeltas, assembleToolCalls, type ToolAcc } from './toolStream';

describe('accumulateToolDeltas', () => {
  it('sets the name once and appends arg fragments per index', () => {
    const acc: ToolAcc = new Map();
    accumulateToolDeltas(acc, [{ index: 0, name: 'get_weather', argsFragment: '{"city":' }]);
    accumulateToolDeltas(acc, [{ index: 0, argsFragment: '"Paris"}' }]);
    expect(acc.get(0)).toEqual({ name: 'get_weather', args: '{"city":"Paris"}' });
  });

  it('keeps separate entries for separate indices', () => {
    const acc: ToolAcc = new Map();
    accumulateToolDeltas(acc, [
      { index: 0, name: 'a', argsFragment: '{}' },
      { index: 1, name: 'b', argsFragment: '{}' },
    ]);
    expect(acc.size).toBe(2);
  });
});

describe('assembleToolCalls', () => {
  it('parses accumulated args into a normalized ToolCall', () => {
    const acc: ToolAcc = new Map([[0, { name: 'get_weather', args: '{"city":"Paris"}' }]]);
    expect(assembleToolCalls(acc)).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
  });

  it('defaults empty args to {}', () => {
    const acc: ToolAcc = new Map([[0, { name: 'noop', args: '' }]]);
    expect(assembleToolCalls(acc)).toEqual([{ name: 'noop', arguments: {} }]);
  });

  it('keeps raw args when JSON parsing fails', () => {
    const acc: ToolAcc = new Map([[0, { name: 'broken', args: '{bad:' }]]);
    expect(assembleToolCalls(acc)).toEqual([{ name: 'broken', arguments: undefined, rawArguments: '{bad:' }]);
  });

  it('drops entries that never received a name', () => {
    const acc: ToolAcc = new Map([[0, { name: '', args: '{}' }]]);
    expect(assembleToolCalls(acc)).toEqual([]);
  });

  it('emits calls sorted by provider index, not by Map-insertion order', () => {
    // Insertion order is 2, 0, 1 — output must be index order 0, 1, 2.
    const acc: ToolAcc = new Map();
    accumulateToolDeltas(acc, [{ index: 2, name: 'third', argsFragment: '{}' }]);
    accumulateToolDeltas(acc, [{ index: 0, name: 'first', argsFragment: '{}' }]);
    accumulateToolDeltas(acc, [{ index: 1, name: 'second', argsFragment: '{}' }]);
    expect(assembleToolCalls(acc).map((c) => c.name)).toEqual(['first', 'second', 'third']);
  });

  it('handles interleaved out-of-order fragments and still sorts by index', () => {
    const acc: ToolAcc = new Map();
    accumulateToolDeltas(acc, [
      { index: 1, name: 'b', argsFragment: '{"x":' },
      { index: 0, name: 'a', argsFragment: '{"y":' },
    ]);
    accumulateToolDeltas(acc, [
      { index: 0, argsFragment: '1}' },
      { index: 1, argsFragment: '2}' },
    ]);
    expect(assembleToolCalls(acc)).toEqual([
      { name: 'a', arguments: { y: 1 } },
      { name: 'b', arguments: { x: 2 } },
    ]);
  });
});
