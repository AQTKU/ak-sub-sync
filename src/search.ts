import type { SubtitleCue, SpeakerSegment, AudioEdge } from './types.js';
import type { Segment } from './segment.js';
import {
  type ScoreConfig,
  type ScoringLut,
  type CueClassification,
  DEFAULT_SCORE_CONFIG,
  buildScoringLut,
  classifyAllCues,
} from './score.js';

// ── Frame rate constants ─────────────────────────────────────

const FRAME_RATES = [23.976, 23.98, 24, 25, 29.97, 30] as const;

// ── Configuration ────────────────────────────────────────────

export interface SearchConfig {
  /** Video frame rate (default: 23.976) */
  frameRate: number;
  /** Offset search range — searches ±this many seconds (default: 5) */
  offsetRangeSec: number;
  /** Center point for offset search (default: 0). Set to previous
   *  segment's offset to track accumulating drift. */
  offsetCenter: number;
  /** Custom ratio list; omit to auto-generate from frame rate pairs */
  ratios?: number[];
  /** Scoring parameters forwarded to the LUT + classifier */
  scoreConfig: Partial<ScoreConfig>;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  frameRate: 23.976,
  offsetRangeSec: 5.0,
  offsetCenter: 0,
  scoreConfig: {},
};

// ── Result types ─────────────────────────────────────────────

export interface RatioResult {
  ratio: number;
  label: string;
  bestOffset: number;   // seconds
  bestScore: number;
}

export interface SearchResult {
  bestRatio: number;
  bestOffset: number;   // seconds
  bestScore: number;
  /** Per-ratio bests, sorted by score descending */
  ratioResults: RatioResult[];
  totalIterations: number;
  elapsedMs: number;
}

// ── Ratio battery ────────────────────────────────────────────

/** Describe a ratio as a frame-rate fraction, e.g. "24/23.976". */
export function describeRatio(ratio: number): string {
  if (Math.abs(ratio - 1.0) < 1e-7) return '1:1';

  for (const a of FRAME_RATES) {
    for (const b of FRAME_RATES) {
      if (a === b) continue;
      if (Math.abs(a / b - ratio) < 1e-6) {
        return `${a}/${b}`;
      }
    }
  }

  return `×${ratio.toFixed(6)}`;
}

/**
 * Build the full set of frame-rate ratios to try.
 * Every ordered pair a/b from the standard frame rates, plus 1.0.
 * Deduplicated to 6 decimal places.
 */
export function buildRatioBattery(custom?: number[]): number[] {
  if (custom) return [...custom].sort((a, b) => a - b);

  const seen = new Set<string>();
  const ratios: number[] = [];

  const add = (r: number) => {
    const key = r.toFixed(6);
    if (seen.has(key)) return;
    seen.add(key);
    ratios.push(r);
  };

  add(1.0);
  for (const a of FRAME_RATES) {
    for (const b of FRAME_RATES) {
      if (a !== b) add(a / b);
    }
  }

  return ratios.sort((a, b) => a - b);
}

// ── Hot loop ─────────────────────────────────────────────────
//
// This function is called (ratios × offsets) times — thousands
// of invocations. Everything it touches is precomputed.

function scoreAtAlignment(
  cueStarts: Float64Array,
  cueWeights: Float32Array,
  vadStarts: Float64Array,
  lut: ScoringLut,
  ratio: number,
  offset: number,
): number {
  let total = 0;
  const n = cueStarts.length;
  const lutValues = lut.values;
  const lutMin = lut.minOffsetMs;
  const lutStep = lut.stepMs;
  const lutLen = lutValues.length;
  const vadLen = vadStarts.length;

  for (let i = 0; i < n; i++) {
    const adjusted = cueStarts[i] * ratio + offset;

    // ── Inline binary search for nearest VAD start ──
    let lo = 0;
    let hi = vadLen - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vadStarts[mid] < adjusted) lo = mid + 1;
      else hi = mid;
    }
    let nearest = vadStarts[lo];
    if (lo > 0) {
      const prev = vadStarts[lo - 1];
      if (Math.abs(prev - adjusted) < Math.abs(nearest - adjusted)) {
        nearest = prev;
      }
    }

    // ── Inline LUT lookup ──
    const diffMs = (adjusted - nearest) * 1000;
    const idx = Math.round((diffMs - lutMin) / lutStep);
    if (idx >= 0 && idx < lutLen) {
      total += lutValues[idx] * cueWeights[i];
    }
  }

  return total;
}

// ── Main search ──────────────────────────────────────────────

/**
 * Brute-force search over all (ratio, offset) combinations.
 *
 * Designed to be called per-segment once segmenting is added:
 *   - First segment: full ratio battery + offset search
 *   - Remaining segments: fixed ratio, offset search only
 *
 * Pass `config.ratios = [knownRatio]` to lock the ratio for
 * subsequent segments.
 */
export function searchBestAlignment(
  cues: SubtitleCue[],
  speakerSegments: SpeakerSegment[],
  speakerChanges: AudioEdge[],
  config?: Partial<SearchConfig>,
): SearchResult {
  const t0 = performance.now();
  const cfg: SearchConfig = { ...DEFAULT_SEARCH_CONFIG, ...config };
  const scoreCfg: ScoreConfig = {
    ...DEFAULT_SCORE_CONFIG,
    ...cfg.scoreConfig,
    frameRate: cfg.frameRate,
  };

  // ── Precompute (once) ──
  const lut = buildScoringLut(scoreCfg);

  const changeTimes = speakerChanges
    .map(c => c.time)
    .sort((a, b) => a - b);

  const classifications = classifyAllCues(cues, changeTimes, scoreCfg);

  // Pack into typed arrays for the hot loop
  const cueStarts = new Float64Array(cues.length);
  const cueWeights = new Float32Array(cues.length);
  for (let i = 0; i < cues.length; i++) {
    cueStarts[i] = cues[i].start;
    cueWeights[i] = classifications[i].weight;
  }

  const vadStarts = new Float64Array(
    speakerSegments.map(s => s.start).sort((a, b) => a - b),
  );

  // ── Ratio battery ──
  const ratios = buildRatioBattery(cfg.ratios);

  // ── Offset grid (centered on offsetCenter so the search
  //    tracks accumulating drift across segments) ──
  const frameDuration = 1 / cfg.frameRate;
  const center = cfg.offsetCenter;
  const maxSteps = Math.floor(cfg.offsetRangeSec / frameDuration);
  const totalOffsets = 2 * maxSteps + 1;

  const totalIterations = ratios.length * totalOffsets;

  // ── Search ──
  let bestRatio = 1.0;
  let bestOffset = 0;
  let bestScore = -Infinity;
  const ratioResults: RatioResult[] = [];

  for (const ratio of ratios) {
    let rBestOffset = 0;
    let rBestScore = -Infinity;

    for (let step = -maxSteps; step <= maxSteps; step++) {
      const offset = center + step * frameDuration;
      const score = scoreAtAlignment(
        cueStarts, cueWeights, vadStarts, lut, ratio, offset,
      );

      if (score > rBestScore) {
        rBestScore = score;
        rBestOffset = offset;
      }
    }

    ratioResults.push({
      ratio,
      label: describeRatio(ratio),
      bestOffset: rBestOffset,
      bestScore: rBestScore,
    });

    if (rBestScore > bestScore) {
      bestScore = rBestScore;
      bestOffset = rBestOffset;
      bestRatio = ratio;
    }
  }

  // Sort by score for diagnostics
  ratioResults.sort((a, b) => b.bestScore - a.bestScore);

  const elapsedMs = performance.now() - t0;

  return {
    bestRatio,
    bestOffset,
    bestScore,
    ratioResults,
    totalIterations,
    elapsedMs,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Apply a ratio + offset correction to cue timestamps.
 * Returns a new array — original cues are not mutated.
 */
export function adjustCues(
  cues: SubtitleCue[],
  ratio: number,
  offset: number,
): SubtitleCue[] {
  return cues.map(c => ({
    ...c,
    start: c.start * ratio + offset,
    end: c.end * ratio + offset,
  }));
}

// ── Segmented search ─────────────────────────────────────

export interface SegmentSearchResult {
  segment: Segment;
  bestOffset: number;   // seconds
  bestScore: number;
  cueCount: number;
}

export interface SegmentedSearchResult {
  /** Globally winning ratio (validated across all segments) */
  ratio: number;
  ratioLabel: string;
  /** Per-segment results at the winning ratio */
  segments: SegmentSearchResult[];
  /** Nearby ratios tested in pass 2, sorted by total score desc */
  ratioCompetition: { ratio: number; label: string; totalScore: number }[];
  /** True if all segment offsets are within 100ms of the mean */
  isUniform: boolean;
  /** If uniform, the mean offset; otherwise undefined */
  uniformOffset?: number;
  /** Sum of per-segment best scores */
  totalScore: number;
  totalIterations: number;
  elapsedMs: number;
}

/** Max distance between ratios to be considered "nearby" (default 0.002).
 *  This captures the cluster around any given ratio (e.g. 23.976/23.98,
 *  1:1, and 23.98/23.976 are all within 0.002 of each other) while
 *  excluding fundamentally different conversions like 23.976/24. */
const NEARBY_RATIO_THRESHOLD = 0.002;

/**
 * Two-pass segmented search.
 *
 * Pass 1 — Segment 0 runs the full ratio battery to find the
 *   approximate ratio and identify the nearby cluster.
 *
 * Pass 2 — Every ratio in the nearby cluster is tested across
 *   ALL segments with offset chaining.  The ratio with the
 *   highest total score wins globally.
 *
 * This lets a 23.976/23.98 pick from segment 0 drift back to
 * 1:1 if the full-file evidence supports it, without wasting
 * time testing distant ratios like 25/24.
 */
export function searchSegmented(
  segments: Segment[],
  cues: SubtitleCue[],
  speakerSegments: SpeakerSegment[],
  speakerChanges: AudioEdge[],
  config?: Partial<SearchConfig>,
): SegmentedSearchResult {
  const t0 = performance.now();
  let totalIterations = 0;

  // ── Pass 1: Segment 0, full battery → approximate ratio ──
  const seg0Cues = cuesInRange(cues, segments[0].start, segments[0].end);
  const seg0Result = searchBestAlignment(
    seg0Cues, speakerSegments, speakerChanges, config,
  );
  totalIterations += seg0Result.totalIterations;

  const approxRatio = seg0Result.bestRatio;

  // Build nearby cluster
  const allRatios = buildRatioBattery(config?.ratios);
  const nearbyRatios = allRatios.filter(
    r => Math.abs(r - approxRatio) <= NEARBY_RATIO_THRESHOLD,
  );

  // ── Pass 2: test each nearby ratio across ALL segments ──
  interface RatioCandidate {
    ratio: number;
    label: string;
    totalScore: number;
    segResults: SegmentSearchResult[];
  }

  const candidates: RatioCandidate[] = [];

  for (const ratio of nearbyRatios) {
    let prevOffset = 0;
    let totalScore = 0;
    const segResults: SegmentSearchResult[] = [];

    for (const segment of segments) {
      const segCues = cuesInRange(cues, segment.start, segment.end);
      const result = searchBestAlignment(
        segCues, speakerSegments, speakerChanges, {
          ...config,
          ratios: [ratio],
          offsetCenter: prevOffset,
        },
      );
      totalIterations += result.totalIterations;

      segResults.push({
        segment,
        bestOffset: result.bestOffset,
        bestScore: result.bestScore,
        cueCount: segCues.length,
      });

      totalScore += result.bestScore;
      prevOffset = result.bestOffset;
    }

    candidates.push({
      ratio,
      label: describeRatio(ratio),
      totalScore,
      segResults,
    });
  }

  // Pick the global winner
  candidates.sort((a, b) => b.totalScore - a.totalScore);
  const winner = candidates[0];

  // ── Uniformity check ──
  const offsets = winner.segResults.map(r => r.bestOffset);
  const meanOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const maxDeviation = Math.max(...offsets.map(o => Math.abs(o - meanOffset)));
  const isUniform = maxDeviation < 0.1; // 100ms

  const elapsedMs = performance.now() - t0;

  return {
    ratio: winner.ratio,
    ratioLabel: winner.label,
    segments: winner.segResults,
    ratioCompetition: candidates.map(c => ({
      ratio: c.ratio,
      label: c.label,
      totalScore: c.totalScore,
    })),
    isUniform,
    uniformOffset: isUniform ? meanOffset : undefined,
    totalScore: winner.totalScore,
    totalIterations,
    elapsedMs,
  };
}

/**
 * Apply per-segment corrections to cue timestamps.
 * If the result is uniform, applies a single global offset instead.
 */
export function adjustCuesSegmented(
  cues: SubtitleCue[],
  result: SegmentedSearchResult,
): SubtitleCue[] {
  const { ratio, isUniform, uniformOffset, segments } = result;

  if (isUniform && uniformOffset !== undefined) {
    return adjustCues(cues, ratio, uniformOffset);
  }

  // Per-segment offsets
  return cues.map(c => {
    // Find the segment this cue belongs to
    const seg = segments.find(
      s => c.start >= s.segment.start && c.start < s.segment.end,
    );
    const offset = seg ? seg.bestOffset : segments[0].bestOffset;
    return {
      ...c,
      start: c.start * ratio + offset,
      end: c.end * ratio + offset,
    };
  });
}

/** Filter cues whose start falls within [rangeStart, rangeEnd). */
function cuesInRange(
  cues: SubtitleCue[],
  rangeStart: number,
  rangeEnd: number,
): SubtitleCue[] {
  return cues.filter(c => c.start >= rangeStart && c.start < rangeEnd);
}
