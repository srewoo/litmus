import { describe, it, expect } from 'vitest';
import { checkImage } from './image';
import type { ImageSignals } from '../../shared/media';

const base: ImageSignals = {
  decoded: true,
  width: 1024,
  height: 1024,
  format: 'png',
  count: 1,
  safetyBlocked: false,
  labels: ['a red cube on a table'],
  ocrText: '',
};

describe('checkImage', () => {
  it('should pass when gates and content all match', () => {
    const r = checkImage(base, { width: 1024, height: 1024, formats: ['png'], count: 1, mustContain: ['cube'] });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(10);
    expect(r.dimensions.find((d) => d.dimension === 'object_presence')?.score).toBe(10);
  });

  it('should fail (score 0) and give a reason when safety-blocked', () => {
    const r = checkImage({ ...base, safetyBlocked: true }, {});
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reasons.join()).toMatch(/safety-blocked/);
  });

  it('should fail on undecodable output', () => {
    expect(checkImage({ ...base, decoded: false }, {}).reasons.join()).toMatch(/did not decode/);
  });

  it('should fail on format / dimension / count mismatch', () => {
    expect(checkImage(base, { formats: ['jpeg'] }).reasons.join()).toMatch(/format png/);
    expect(checkImage(base, { width: 512 }).reasons.join()).toMatch(/width 1024/);
    expect(checkImage(base, { height: 512 }).reasons.join()).toMatch(/height 1024/);
    expect(checkImage(base, { count: 4 }).reasons.join()).toMatch(/requested 4/);
  });

  it('should report a missing requested element and grade the dimension partially', () => {
    const r = checkImage({ ...base, labels: ['a dog'] }, { mustContain: ['cat', 'dog'] });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/missing requested element.*cat/);
    expect(r.dimensions.find((d) => d.dimension === 'object_presence')?.score).toBe(5);
  });

  it('should fail negative-adherence when a forbidden element appears', () => {
    const r = checkImage({ ...base, labels: ['text watermark'] }, { mustNotContain: ['text'] });
    expect(r.passed).toBe(false);
    expect(r.dimensions.find((d) => d.dimension === 'negative_adherence')?.score).toBe(0);
  });

  it('should check requested in-image text via OCR', () => {
    expect(checkImage({ ...base, ocrText: 'SALE 50% OFF' }, { text: 'sale' }).passed).toBe(true);
    expect(checkImage({ ...base, ocrText: 'nope' }, { text: 'sale' }).reasons.join()).toMatch(/not found/);
  });

  it('should grade edit-consistency by reference distance', () => {
    const pass = checkImage({ ...base, refDistance: 2 }, { maxRefDistance: 8 });
    expect(pass.passed).toBe(true);
    expect(pass.dimensions.find((d) => d.dimension === 'edit_consistency')?.score).toBeGreaterThan(8);
    const fail = checkImage({ ...base, refDistance: 20 }, { maxRefDistance: 8 });
    expect(fail.passed).toBe(false);
    expect(fail.reasons.join()).toMatch(/changed too much/);
  });
});
