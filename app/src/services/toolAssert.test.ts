import { describe, it, expect } from 'vitest';
import { assertToolCalls, validateArgsSchema, describeToolAssert } from './toolAssert';
import type { ToolCall, ToolDef } from '../shared/types';

const weatherDef: ToolDef = {
  name: 'get_weather',
  parameters: {
    type: 'object',
    required: ['city'],
    properties: { city: { type: 'string' }, days: { type: 'integer' } },
  },
};

const call = (name: string, args: unknown, rawArguments?: string): ToolCall =>
  rawArguments === undefined ? { name, arguments: args } : { name, arguments: args, rawArguments };

describe('validateArgsSchema', () => {
  it('passes a well-formed object', () => {
    expect(validateArgsSchema({ city: 'Paris', days: 3 }, weatherDef.parameters)).toEqual([]);
  });
  it('flags a missing required arg', () => {
    expect(validateArgsSchema({ days: 3 }, weatherDef.parameters)[0]).toMatch(/missing required argument "city"/);
  });
  it('flags a wrong primitive type', () => {
    expect(validateArgsSchema({ city: 'Paris', days: 'three' }, weatherDef.parameters)[0]).toMatch(/should be integer/);
  });
  it('accepts an integer where number is expected', () => {
    expect(validateArgsSchema({ x: 5 }, { type: 'object', properties: { x: { type: 'number' } } })).toEqual([]);
  });
  it('rejects a non-object when object is required', () => {
    expect(validateArgsSchema('nope', weatherDef.parameters)[0]).toMatch(/must be an object/);
  });
});

describe('assertToolCalls', () => {
  it('passes when the expected tool is called with valid args', () => {
    const r = assertToolCalls([call('get_weather', { city: 'Paris' })], { expectedTool: 'get_weather' }, [weatherDef]);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(10);
  });

  it('fails when the expected tool was not called', () => {
    const r = assertToolCalls([call('search', {})], { expectedTool: 'get_weather' }, [weatherDef]);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/was not called/);
  });

  it('fails when a forbidden tool is called', () => {
    const r = assertToolCalls([call('delete_account', {})], { forbiddenTools: ['delete_account'] });
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/forbidden tool "delete_account"/);
  });

  it('fails when required args are missing per the schema', () => {
    const r = assertToolCalls([call('get_weather', { days: 2 })], { expectedTool: 'get_weather' }, [weatherDef]);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/missing required argument "city"/);
  });

  it('fails when arguments did not parse as JSON', () => {
    const r = assertToolCalls([call('get_weather', undefined, '{city:')], { expectedTool: 'get_weather' }, [weatherDef]);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/not valid JSON/);
  });

  it('enforces requiredArgs exact-value match', () => {
    const exp = { expectedTool: 'get_weather', requiredArgs: { city: 'Paris' } };
    expect(assertToolCalls([call('get_weather', { city: 'Paris' })], exp, [weatherDef]).passed).toBe(true);
    const bad = assertToolCalls([call('get_weather', { city: 'London' })], exp, [weatherDef]);
    expect(bad.passed).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/should equal "Paris"/);
  });

  it('passes a trivially empty expectation', () => {
    expect(assertToolCalls([call('anything', {})], {}).passed).toBe(true);
  });

  it('passes a forbidden-only expectation when a different tool with invalid args is called (forbidden avoided)', () => {
    // Adversarial case: only forbiddenTools, no expectedTool. The model avoids
    // the forbidden tool but calls another tool with imperfect args. With no
    // expectedTool we must NOT validate that arbitrary call's args/schema.
    const r = assertToolCalls(
      [call('get_weather', { days: 'three' })], // missing required city + wrong type
      { forbiddenTools: ['delete_account'] },
      [weatherDef],
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(10);
    expect(r.reasons).toEqual([]);
  });

  it('still fails a forbidden-only expectation when the forbidden tool is called', () => {
    const r = assertToolCalls([call('delete_account', {})], { forbiddenTools: ['delete_account'] }, [weatherDef]);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/forbidden tool "delete_account"/);
  });

  it('fails a requiredArgs-only expectation when no call satisfies the required args', () => {
    // Without expectedTool the assertion is "SOME call carried these args"; it
    // fails only when no call matches (not vacuously true).
    const r = assertToolCalls([call('get_weather', { city: 'London' })], { requiredArgs: { city: 'Paris' } });
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no tool call carried the required args/);
  });

  it('passes a requiredArgs-only expectation when at least one call satisfies the args', () => {
    // A matching call alongside an unrelated one (e.g. a logging call) must still
    // pass — requiring EVERY call to match would false-fail a valid trajectory.
    const r = assertToolCalls(
      [call('log_event', { name: 'search' }), call('get_weather', { city: 'Paris' })],
      { requiredArgs: { city: 'Paris' } },
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(10);
  });

  it('fails a requiredArgs-only expectation when no tool was called at all', () => {
    const r = assertToolCalls([], { requiredArgs: { city: 'Paris' } });
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/no tool was called/);
  });

  it('does not validate an arbitrary first call when there is no expectedTool', () => {
    // First call has unparseable args; without expectedTool it is not validated.
    const r = assertToolCalls([call('search', undefined, '{bad:'), call('get_weather', { city: 'Paris' })], {});
    expect(r.passed).toBe(true);
  });

  it('describes the verdict in one line', () => {
    expect(describeToolAssert({ passed: true, score: 10, reasons: [] })).toMatch(/met/);
    expect(describeToolAssert({ passed: false, score: 0, reasons: ['a', 'b'] })).toMatch(/a; b/);
  });
});
