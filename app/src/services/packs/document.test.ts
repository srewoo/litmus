import { describe, it, expect } from 'vitest';
import { checkDocument } from './document';
import type { DocumentSignals } from '../../shared/media';

const base: DocumentSignals = {
  parsed: true,
  format: 'pdf',
  pageCount: 3,
  text: 'Executive Summary\nRevenue was $4.2M in Q3 2026.\nOutlook',
  placeholders: [],
  tableCount: 2,
  hasCorruptEmbeds: false,
};

describe('checkDocument', () => {
  it('should pass when structure and data are all correct', () => {
    const r = checkDocument(base, {
      format: 'pdf',
      pageCount: 3,
      sections: ['Executive Summary', 'Outlook'],
      requiredData: ['$4.2M', 'Q3 2026'],
      minTables: 2,
    });
    expect(r.passed).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === 'data_fidelity')?.score).toBe(10);
  });

  it('should catch a hallucinated figure (missing verbatim data point)', () => {
    const r = checkDocument(base, { requiredData: ['$4.2M', '$9.9M'] });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/missing\/mismatched data point.*\$9\.9M/);
    expect(r.dimensions.find((d) => d.dimension === 'data_fidelity')?.score).toBe(5);
  });

  it('should gate on parse, format, and page count', () => {
    expect(checkDocument({ ...base, parsed: false }, {}).reasons.join()).toMatch(/did not parse/);
    expect(checkDocument(base, { format: 'pptx' }).reasons.join()).toMatch(/format pdf/);
    expect(checkDocument(base, { pageCount: 5 }).reasons.join()).toMatch(/3 page/);
  });

  it('should fail on unresolved placeholders by default and pass when disabled', () => {
    const withPh = { ...base, placeholders: ['{{name}}'] };
    expect(checkDocument(withPh, {}).reasons.join()).toMatch(/unresolved placeholder.*\{\{name\}\}/);
    expect(checkDocument(withPh, { noPlaceholders: false }).passed).toBe(true);
  });

  it('should fail on corrupt embeds', () => {
    expect(checkDocument({ ...base, hasCorruptEmbeds: true }, {}).reasons.join()).toMatch(/corrupt/);
  });

  it('should report missing sections', () => {
    expect(checkDocument(base, { sections: ['Appendix'] }).reasons.join()).toMatch(/missing section.*Appendix/);
  });

  it('should grade table structure below the minimum', () => {
    const r = checkDocument({ ...base, tableCount: 1 }, { minTables: 4 });
    expect(r.passed).toBe(false);
    expect(r.dimensions.find((d) => d.dimension === 'table_structure')?.score).toBeCloseTo(2.5);
  });
});
