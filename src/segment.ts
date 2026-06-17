import type { SubtitleCue, WaveformData, Chapter } from './types.js';

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

const DEFAULT_SILENCE_THRESHOLD = 0.001;

export function findSilenceRuns(
  waveform: WaveformData,
  config: { minSilenceSec: number; silenceThreshold?: number },
): SilenceRun[] {
  const threshold = config.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
  const runs: SilenceRun[] = [];
  let runStartWindow = -1;

  for (let w = 0; w < waveform.rms.length; w++) {
    if (waveform.rms[w] <= threshold) {
      if (runStartWindow === -1) runStartWindow = w;
    } else {
      if (runStartWindow !== -1) {
        const startSec = runStartWindow * waveform.windowSize;
        const endSec = w * waveform.windowSize;
        if (endSec - startSec >= config.minSilenceSec) {
          runs.push({ start: startSec, end: endSec });
        }
        runStartWindow = -1;
      }
    }
  }

  if (runStartWindow !== -1) {
    const startSec = runStartWindow * waveform.windowSize;
    const endSec = waveform.rms.length * waveform.windowSize;
    if (endSec - startSec >= config.minSilenceSec) {
      runs.push({ start: startSec, end: endSec });
    }
  }

  return runs;
}

// ── Split point sources ──────────────────────────────────────

export function silenceRunsToSplitPoints(runs: SilenceRun[]): number[] {
  return runs.map(r => (r.start + r.end) / 2);
}

export function findCueGapSplits(cues: SubtitleCue[], minGapSec: number): number[] {
  if (cues.length < 2) return [];
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const splits: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].start - sorted[i - 1].end;
    if (gap >= minGapSec) {
      splits.push((sorted[i - 1].end + sorted[i].start) / 2);
    }
  }
  return splits;
}

export function findChapterSplits(chapters: Chapter[]): number[] {
  return chapters
    .map(ch => ch.start)
    .filter(t => t > 0)
    .sort((a, b) => a - b);
}

// ── Segment boundary selection ───────────────────────────────

/**
 * Build segments from arbitrary split points.
 * Split points are merged, deduplicated, and filtered by minSegmentSec.
 * If the final segment would be too short, it's merged into the previous.
 */
export function buildSegments(
  splitPoints: number[],
  totalDuration: number,
  minSegmentSec: number = 300,
): Segment[] {
  if (splitPoints.length === 0) {
    return [{ index: 0, start: 0, end: totalDuration }];
  }

  const sorted = [...new Set(splitPoints.map(p => +p.toFixed(6)))]
    .sort((a, b) => a - b);

  const boundaries: number[] = [0];

  for (const point of sorted) {
    if (point <= 0 || point >= totalDuration) continue;
    const lastBoundary = boundaries[boundaries.length - 1];
    if (minSegmentSec > 0 && point - lastBoundary < minSegmentSec) {
      continue;
    }
    boundaries.push(point);
  }

  boundaries.push(totalDuration);

  if (minSegmentSec > 0 && boundaries.length >= 3) {
    const lastLen = boundaries[boundaries.length - 1] - boundaries[boundaries.length - 2];
    if (lastLen < minSegmentSec) {
      boundaries.splice(boundaries.length - 2, 1);
    }
  }

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
