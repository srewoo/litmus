/**
 * Export builders (PRD F12). Pure: a version history → a Markdown report or JSON.
 * Uses a minimal local shape so `core` doesn't depend on the platform store.
 */
import type { SpeedAggregate } from '../shared/types';
import { round1 } from '../shared/num';

export interface ReportRun {
  readonly overall: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly total: number;
  readonly speed: SpeedAggregate;
}

export interface ReportEntry {
  readonly label: string;
  readonly note: string;
  readonly prompt: string;
  readonly run: ReportRun | null;
}

export function buildJsonReport(entries: readonly ReportEntry[]): string {
  return JSON.stringify({ tool: 'litmus', kind: 'version-history', versions: entries }, null, 2);
}

export function buildMarkdownReport(entries: readonly ReportEntry[]): string {
  const lines: string[] = ['# litmus — prompt version history', ''];
  if (entries.length === 0) lines.push('_No versions yet._');
  for (const e of entries) {
    lines.push(`## ${e.label}`);
    if (e.run) {
      lines.push(
        `- Score: **${e.run.overall.toFixed(1)}/10** (${e.run.passCount}/${e.run.total} passed, ${e.run.failCount} failed)`,
      );
      lines.push(
        `- Speed: TTFB ${round1(e.run.speed.ttfbMs / 1000)}s · avg ${round1(e.run.speed.avgResponseMs / 1000)}s · ${e.run.speed.tokensPerSec} tok/s`,
      );
    } else {
      lines.push('- _No run recorded._');
    }
    if (e.note) lines.push(`- Note: ${e.note}`);
    lines.push('', '```text', e.prompt, '```', '');
  }
  return lines.join('\n');
}
