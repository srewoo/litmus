/**
 * Media pack dispatcher (ADR 0007). Routes a (signals, expectation) pair to the
 * right pure pack by discriminated `kind`. Kinds must match — a mismatch is a
 * programming error (the run layer pairs them), surfaced as a failing verdict
 * rather than a throw so one bad case never aborts a run.
 */
import type { MediaExpectation, MediaSignals } from '../../shared/media';
import { checkImage } from './image';
import { checkVideo, videoCoverageNote } from './video';
import { checkVoice } from './voice';
import { checkDocument } from './document';
import { foldChecks, describeCheck, type CheckResult } from './types';

export { checkImage, checkVideo, checkVoice, checkDocument, videoCoverageNote, describeCheck };
export type { CheckResult } from './types';

export function checkMedia(signals: MediaSignals, expectation: MediaExpectation): CheckResult {
  if (signals.kind !== expectation.kind) {
    return foldChecks([`signal kind "${signals.kind}" does not match expectation kind "${expectation.kind}"`], []);
  }
  switch (signals.kind) {
    case 'image':
      return checkImage(signals, expectation as Extract<MediaExpectation, { kind: 'image' }>);
    case 'video':
      return checkVideo(signals, expectation as Extract<MediaExpectation, { kind: 'video' }>);
    case 'voice':
      return checkVoice(signals, expectation as Extract<MediaExpectation, { kind: 'voice' }>);
    case 'document':
      return checkDocument(signals, expectation as Extract<MediaExpectation, { kind: 'document' }>);
  }
}
