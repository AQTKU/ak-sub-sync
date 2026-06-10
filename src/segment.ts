import type { WaveformData } from './types.js';

// ── Configuration ────────────────────────────────────────────

export interface SegmentConfig {
  /** Minimum duration of silence to count as a break, in seconds (default: 1.5) */
  minSilenceSec: number;
  /** Minimum segment length in seconds (default: 300 = 5 min) */
  minSegmentSec: number;
  /** RMS threshold below which audio counts as silent (default: 0.001) */
  silenceThreshold: number;
}

export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  minSilenceSec: 1.5,
  minSegmentSec: 300,
  silenceThreshold: 0.001,
};

// ── Types ────────────────────────────────────────────────────

export interface SilenceRun {
  start: number;  // seconds
  end: number;    // seconds
}

export interface Segment {
  index: number;
  start: number;  // seconds
  end: number;    // seconds
}

// ── Silence detection ────────────────────────────────────────

/**
 * Scan the waveform RMS envelope for sustained runs of silence.
 * Returns runs where every RMS window is below the threshold
 * for at least `minDurationSec` consecutive seconds.
 */
export function findSilenceRuns(
  waveform: WaveformData,
  config?: Partial<SegmentConfig>,
): SilenceRun[] {
  const cfg = { ...DEFAULT_SEGMENT_CONFIG, ...config };
  const runs: SilenceRun[] = [];
  let runStartWindow = -1;

  for (let w = 0; w < waveform.rms.length; w++) {
    if (waveform.rms[w] <= cfg.silenceThreshold) {
      if (runStartWindow === -1) runStartWindow = w;
    } else {
      if (runStartWindow !== -1) {
        const startSec = runStartWindow * waveform.windowSize;
        const endSec = w * waveform.windowSize;
        if (endSec - startSec >= cfg.minSilenceSec) {
          runs.push({ start: startSec, end: endSec });
        }
        runStartWindow = -1;
      }
    }
  }

  // Handle silence at end of file
  if (runStartWindow !== -1) {
    const startSec = runStartWindow * waveform.windowSize;
    const endSec = waveform.rms.length * waveform.windowSize;
    if (endSec - startSec >= cfg.minSilenceSec) {
      runs.push({ start: startSec, end: endSec });
    }
  }

  return runs;
}

// ── Segment boundary selection ───────────────────────────────

/**
 * Turn silence runs into segment boundaries.
 *
 * Greedy: walk silence runs left-to-right, placing a split at the
 * midpoint of each run as long as the resulting segment is at least
 * `minSegmentSec` long. If the final segment would be too short,
 * merge it into the previous one.
 */
export function buildSegments(
  silenceRuns: SilenceRun[],
  totalDuration: number,
  config?: Partial<SegmentConfig>,
): Segment[] {
  const cfg = { ...DEFAULT_SEGMENT_CONFIG, ...config };

  if (silenceRuns.length === 0) {
    return [{ index: 0, start: 0, end: totalDuration }];
  }

  // Collect candidate split points (midpoints of silence runs)
  const boundaries: number[] = [0];

  for (const run of silenceRuns) {
    const midpoint = (run.start + run.end) / 2;
    const lastBoundary = boundaries[boundaries.length - 1];

    if (midpoint - lastBoundary >= cfg.minSegmentSec) {
      boundaries.push(midpoint);
    }
  }

  boundaries.push(totalDuration);

  // If the last segment is too short, merge it with the previous one
  if (boundaries.length >= 3) {
    const lastLen = boundaries[boundaries.length - 1] - boundaries[boundaries.length - 2];
    if (lastLen < cfg.minSegmentSec) {
      boundaries.splice(boundaries.length - 2, 1);
    }
  }

  // Build segment objects
  const segments: Segment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    segments.push({
      index: i,
      start: boundaries[i],
      end: boundaries[i + 1],
    });
  }

  return segments;
}
