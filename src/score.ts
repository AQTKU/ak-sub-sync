import type { SubtitleCue, SpeakerSegment, AudioEdge } from './types.js';

// ── Configuration ────────────────────────────────────────────

export interface ScoreConfig {
  /** Video frame rate (default: 23.976) */
  frameRate: number;
  /** Optimal cue lead time in ms — cue starts before speech (default: -50) */
  peakOffsetMs: number;
  /** Left bound of scoring window in ms (default: -500) */
  leftBoundMs: number;
  /** Right bound of scoring window in ms (default: 250) */
  rightBoundMs: number;
  /** Max frames of silence to still count as "immediately following" (default: 3) */
  immediatelyFollowingFrames: number;
  /** Window in ms for matching speaker changes to cues (default: 250) */
  speakerChangeWindowMs: number;
  /** Weight for cues not immediately following previous cue (default: 0.7) */
  weightNotImmediatelyFollowing: number;
  /** Weight for mid-sentence cue breaks (default: 0.2) */
  weightMidSentence: number;
  /** Multiplier for cues aligned with a speaker change (default: 2.0) */
  multiplierSpeakerChange: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  frameRate: 23.976,
  peakOffsetMs: -100,
  leftBoundMs: -500,
  rightBoundMs: 250,
  immediatelyFollowingFrames: 5,
  speakerChangeWindowMs: 250,
  weightNotImmediatelyFollowing: 0.7,
  weightMidSentence: 0.2,
  multiplierSpeakerChange: 2.0,
};

// ── Cue classification ───────────────────────────────────────

export type CueTier = 'spk' | 'new' | 'gap' | 'mid';

export interface CueClassification {
  /** Weight multiplier applied to the raw proximity score */
  weight: number;
  /** Is the gap from the previous cue <= immediatelyFollowingFrames? */
  isImmediatelyFollowing: boolean;
  /** Appears to be a mid-sentence captioner break? */
  isMidSentence: boolean;
  /** VAD speaker change within speakerChangeWindowMs? */
  hasSpeakerChange: boolean;
  /** Short tier label for visualization */
  tier: CueTier;
}

// ── Scored cue ───────────────────────────────────────────────

export interface ScoredCue {
  cue: SubtitleCue;
  classification: CueClassification;
  /** Time of the nearest VAD/speaker-segment start (seconds) */
  nearestVadStart: number;
  /** cue.start − nearestVadStart, in milliseconds (negative = cue leads) */
  offsetMs: number;
  /** Raw proximity score from the LUT (0–1) */
  rawScore: number;
  /** rawScore × classification.weight */
  weightedScore: number;
}

// ── Scoring lookup table ─────────────────────────────────────
//
// Asymmetric piecewise linear triangle:
//
//   1.0 ─────────╮
//                 │╲
//   score    ╱    │  ╲
//           ╱     │    ╲
//   0 ─────╱──────┼──────╲──────
//       -500    -50       250   (ms)
//          left   peak    right
//
// Precomputed at frame-rate intervals so lookup is a single
// array index during the hot loop.

export interface ScoringLut {
  /** Score values, one per frame-step across the window */
  values: Float32Array;
  /** Left edge of the window in ms (negative) */
  minOffsetMs: number;
  /** Step size in ms (= 1000 / frameRate) */
  stepMs: number;
}

export function buildScoringLut(config: ScoreConfig): ScoringLut {
  const stepMs = 1000 / config.frameRate;
  const minOffsetMs = config.leftBoundMs;
  const maxOffsetMs = config.rightBoundMs;
  const steps = Math.ceil((maxOffsetMs - minOffsetMs) / stepMs) + 1;

  const values = new Float32Array(steps);

  for (let i = 0; i < steps; i++) {
    const offsetMs = minOffsetMs + i * stepMs;
    values[i] = rawProximityScore(offsetMs, config);
  }

  return { values, minOffsetMs, stepMs };
}

/** Continuous piecewise linear score — used once to fill the LUT. */
function rawProximityScore(offsetMs: number, config: ScoreConfig): number {
  if (offsetMs <= config.leftBoundMs) return 0;
  if (offsetMs >= config.rightBoundMs) return 0;

  if (offsetMs <= config.peakOffsetMs) {
    // Left ramp: 0 at leftBound → 1.0 at peak
    return (offsetMs - config.leftBoundMs) / (config.peakOffsetMs - config.leftBoundMs);
  } else {
    // Right ramp: 1.0 at peak → 0 at rightBound
    return 1.0 - (offsetMs - config.peakOffsetMs) / (config.rightBoundMs - config.peakOffsetMs);
  }
}

/** Look up a score from the precomputed LUT. O(1). */
export function lookupScore(offsetMs: number, lut: ScoringLut): number {
  const index = Math.round((offsetMs - lut.minOffsetMs) / lut.stepMs);
  if (index < 0 || index >= lut.values.length) return 0;
  return lut.values[index];
}

// ── Binary search ────────────────────────────────────────────

/**
 * Find the value in a sorted array closest to `target`.
 * Returns the value itself (not the index). Returns Infinity if empty.
 */
export function findNearestValue(sorted: number[], target: number): number {
  const n = sorted.length;
  if (n === 0) return Infinity;
  if (n === 1) return sorted[0];

  let lo = 0;
  let hi = n - 1;

  // Standard binary search for insertion point
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }

  // Compare lo and lo−1 for closest
  if (lo > 0 && Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)) {
    return sorted[lo - 1];
  }
  return sorted[lo];
}

// ── Cue classification ───────────────────────────────────────

const SENTENCE_END_RE = /[.!?。！？．｡‽‼⁉⁈…।॥؟۔։።။།។᙮][“”’’」』》〉】›»）)\s]*$/;

/** Strip leading dialogue dash + whitespace to get to the actual word. */
const DIALOGUE_PREFIX_RE = /^[-–—♪]\s*/;

function classifyCue(
  cue: SubtitleCue,
  prevCue: SubtitleCue | null,
  speakerChangeTimes: number[],
  config: ScoreConfig,
): CueClassification {
  const frameDuration = 1 / config.frameRate;
  const maxGap = config.immediatelyFollowingFrames * frameDuration;

  // ── Is this cue immediately following the previous? ──
  const isImmediatelyFollowing =
    prevCue !== null && (cue.start - prevCue.end) <= maxGap;

  if (!isImmediatelyFollowing) {
    return {
      weight: config.weightNotImmediatelyFollowing,
      isImmediatelyFollowing: false,
      isMidSentence: false,
      hasSpeakerChange: false,
      tier: 'gap',
    };
  }

  // ── Immediately following — is it a mid-sentence break? ──
  // Two independent signals, either one is sufficient:
  //   1. Text starts with a lowercase letter (after stripping dialogue dash)
  //   2. Previous cue didn't end with sentence punctuation

  const textAfterDash = cue.text.replace(DIALOGUE_PREFIX_RE, '');
  const startsLowercase = /^[a-z]/.test(textAfterDash);
  const prevEndsPunctuation = prevCue !== null && SENTENCE_END_RE.test(prevCue.text);
  const isMidSentence = startsLowercase || !prevEndsPunctuation;

  if (isMidSentence) {
    return {
      weight: config.weightMidSentence,
      isImmediatelyFollowing: true,
      isMidSentence: true,
      hasSpeakerChange: false,
      tier: 'mid',
    };
  }

  // ── New sentence — check for speaker change nearby ──
  const windowSec = config.speakerChangeWindowMs / 1000;
  const nearestChange = findNearestValue(speakerChangeTimes, cue.start);
  const hasSpeakerChange = Math.abs(nearestChange - cue.start) <= windowSec;

  if (hasSpeakerChange) {
    return {
      weight: config.multiplierSpeakerChange,
      isImmediatelyFollowing: true,
      isMidSentence: false,
      hasSpeakerChange: true,
      tier: 'spk',
    };
  }

  // ── New sentence, no speaker change — default weight ──
  return {
    weight: 1.0,
    isImmediatelyFollowing: true,
    isMidSentence: false,
    hasSpeakerChange: false,
    tier: 'new',
  };
}

// ── Batch classification ─────────────────────────────────────

/**
 * Classify all cues in one pass — precomputes weights for the
 * search hot loop so classification isn't repeated per-iteration.
 */
export function classifyAllCues(
  cues: SubtitleCue[],
  speakerChangeTimes: number[],
  config: ScoreConfig,
): CueClassification[] {
  const results: CueClassification[] = new Array(cues.length);
  for (let i = 0; i < cues.length; i++) {
    results[i] = classifyCue(
      cues[i],
      i > 0 ? cues[i - 1] : null,
      speakerChangeTimes,
      config,
    );
  }
  return results;
}

// ── Main scoring function ────────────────────────────────────

export function scoreCues(
  cues: SubtitleCue[],
  speakerSegments: SpeakerSegment[],
  speakerChanges: AudioEdge[],
  config?: Partial<ScoreConfig>,
): ScoredCue[] {
  const cfg: ScoreConfig = { ...DEFAULT_SCORE_CONFIG, ...config };
  const lut = buildScoringLut(cfg);

  // All speaker-segment starts are candidate VAD match points.
  // These are already in chronological order from pyannote.
  const vadStarts = speakerSegments.map(s => s.start);

  // Speaker change times (sorted)
  const changeTimes = speakerChanges
    .map(c => c.time)
    .sort((a, b) => a - b);

  const results: ScoredCue[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const prevCue = i > 0 ? cues[i - 1] : null;

    const classification = classifyCue(cue, prevCue, changeTimes, cfg);
    const nearestVadStart = findNearestValue(vadStarts, cue.start);
    const offsetMs = (cue.start - nearestVadStart) * 1000;
    const rawScore = lookupScore(offsetMs, lut);
    const weightedScore = rawScore * classification.weight;

    results.push({
      cue,
      classification,
      nearestVadStart,
      offsetMs,
      rawScore,
      weightedScore,
    });
  }

  return results;
}

// ── Summary stats ────────────────────────────────────────────

export function scoreSummary(scored: ScoredCue[]): {
  totalWeightedScore: number;
  cueCount: number;
  tierCounts: Record<CueTier, number>;
  meanRawScore: number;
  meanWeightedScore: number;
} {
  const tierCounts: Record<CueTier, number> = { spk: 0, new: 0, gap: 0, mid: 0 };
  let totalRaw = 0;
  let totalWeighted = 0;

  for (const s of scored) {
    tierCounts[s.classification.tier]++;
    totalRaw += s.rawScore;
    totalWeighted += s.weightedScore;
  }

  return {
    totalWeightedScore: totalWeighted,
    cueCount: scored.length,
    tierCounts,
    meanRawScore: scored.length > 0 ? totalRaw / scored.length : 0,
    meanWeightedScore: scored.length > 0 ? totalWeighted / scored.length : 0,
  };
}
