/**
 * Media evaluator-pack domain types (ADR 0007).
 *
 * litmus's text/tool/agent paths all terminate in a string. Media generation
 * (image/video/voice/document) does not, so it gets its own case kinds. The
 * design principle carried from ADR 0001 is unchanged: assert what is
 * deterministically checkable (format, dimensions, duration, WER, exact data
 * match) and reserve the LLM judge for the subjective residue (aesthetics,
 * naturalness, narrative). These types model the two halves of that split:
 *   - a per-modality EXPECTATION (what the prompt asked for), and
 *   - a per-modality SIGNALS object (what the injected checkers extracted from the
 *     generated artifact — decode/probe, detector, OCR, ASR, PDF text, hash).
 * The pure `check*` functions (services/packs/*) take (signals, expectation) and
 * return a deterministic verdict; extraction is the injected side-effect boundary
 * (a BYOK checker-model call or a WASM decoder), never bundled here (ADR 0007).
 */

export type MediaKind = 'image' | 'video' | 'voice' | 'document';

/* ---------- Image ---------- */

export interface ImageExpectation {
  readonly width?: number;
  readonly height?: number;
  /** Acceptable formats, lowercased (e.g. ['png','webp']). */
  readonly formats?: readonly string[];
  /** Exact number of images the prompt asked for. */
  readonly count?: number;
  /** Labels/objects that must be detected in the image. */
  readonly mustContain?: readonly string[];
  /** Labels/objects that must NOT appear (negative-instruction adherence). */
  readonly mustNotContain?: readonly string[];
  /** Text the image must render (checked via OCR, case-insensitive substring). */
  readonly text?: string;
  /** Max perceptual-hash distance vs the reference (edit-consistency); needs refDistance. */
  readonly maxRefDistance?: number;
}

export interface ImageSignals {
  readonly decoded: boolean;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly count: number;
  readonly safetyBlocked: boolean;
  readonly labels: readonly string[];
  readonly ocrText: string;
  /** Perceptual-hash distance to a supplied reference (0 = identical); absent if no ref. */
  readonly refDistance?: number;
}

/* ---------- Video ---------- */

export interface VideoExpectation {
  readonly durationSec?: number;
  /** Allowed absolute error on duration, seconds (default 0.5). */
  readonly durationToleranceSec?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly formats?: readonly string[];
  readonly hasAudio?: boolean;
  readonly minFrames?: number;
  /** Max acceptable flicker score (0 = perfectly stable, 1 = severe); default 0.2. */
  readonly maxFlicker?: number;
  /** Labels that must appear across the sampled frames. */
  readonly mustContain?: readonly string[];
}

export interface VideoSignals {
  readonly decoded: boolean;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly format: string;
  readonly hasAudio: boolean;
  readonly frameCount: number;
  /** How many frames the checker actually sampled (for the coverage note). */
  readonly sampledFrames: number;
  /** 0–1 temporal-flicker score across sampled frames. */
  readonly flicker: number;
  readonly labels: readonly string[];
  readonly safetyBlocked: boolean;
}

/* ---------- Voice / audio ---------- */

export interface VoiceExpectation {
  /** The text the TTS was asked to speak (drives the ASR round-trip WER check). */
  readonly text?: string;
  /** Max acceptable word-error-rate (0–1) of the ASR round-trip; default 0.15. */
  readonly maxWer?: number;
  /** Expected BCP-47 language of the output (e.g. 'en'). */
  readonly language?: string;
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  /** Requested voice id; needs voiceSimilarity to check. */
  readonly voiceId?: string;
  /** Min speaker-embedding similarity to the requested voice (0–1); default 0.7. */
  readonly minVoiceSimilarity?: number;
}

export interface VoiceSignals {
  readonly decoded: boolean;
  readonly durationSec: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Root-mean-square energy (0 = silence). */
  readonly rms: number;
  /** True if the waveform clips (peaks pinned to full-scale). */
  readonly clipping: boolean;
  readonly transcript: string;
  /** Word-error-rate of transcript vs the requested text (0–1); absent if no text. */
  readonly wer?: number;
  readonly language: string;
  /** Speaker-embedding similarity to the requested voice (0–1); absent if no voiceId. */
  readonly voiceSimilarity?: number;
}

/* ---------- Document (PDF / PPT) ---------- */

export interface DocumentExpectation {
  readonly format?: 'pdf' | 'pptx';
  readonly pageCount?: number;
  /** Section headings that must be present. */
  readonly sections?: readonly string[];
  /** Data points (numbers/dates/strings) that must appear VERBATIM — catches hallucinated figures. */
  readonly requiredData?: readonly string[];
  /** Minimum tables the document must contain. */
  readonly minTables?: number;
  /** Fail if any unresolved template placeholder (e.g. {{name}}) survives. Default true. */
  readonly noPlaceholders?: boolean;
}

export interface DocumentSignals {
  readonly parsed: boolean;
  readonly format: string;
  readonly pageCount: number;
  /** All extracted text (used for section + verbatim data-point checks). */
  readonly text: string;
  /** Unresolved placeholder tokens found (e.g. ['{{name}}']). */
  readonly placeholders: readonly string[];
  readonly tableCount: number;
  /** True if any embedded image/chart failed to decode. */
  readonly hasCorruptEmbeds: boolean;
}

/* ---------- Discriminated unions used by the run/dispatch layer ---------- */

export type MediaExpectation =
  | ({ readonly kind: 'image' } & ImageExpectation)
  | ({ readonly kind: 'video' } & VideoExpectation)
  | ({ readonly kind: 'voice' } & VoiceExpectation)
  | ({ readonly kind: 'document' } & DocumentExpectation);

export type MediaSignals =
  | ({ readonly kind: 'image' } & ImageSignals)
  | ({ readonly kind: 'video' } & VideoSignals)
  | ({ readonly kind: 'voice' } & VoiceSignals)
  | ({ readonly kind: 'document' } & DocumentSignals);
