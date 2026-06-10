import type { SubtitleCue, SpeechRegion, WaveformData, AudioEdge, SpeakerSegment } from './types.js';
import type { ScoredCue, CueTier } from './score.js';

interface VizOptions {
  pixelsPerSecond: number;
  startTime: number;
  endTime: number;
}

// Speaker class → color mapping
const SPEAKER_COLORS: Record<number, string> = {
  1: '#ff6b6b', // speaker A — coral
  2: '#6bddaa', // speaker B — green
  3: '#6b9eff', // speaker C — blue
  4: '#ffaa6b', // A+B overlap — orange
  5: '#aa6bff', // A+C overlap — purple
  6: '#ffdd6b', // B+C overlap — yellow
};

function speakerColor(cls: number): string {
  return SPEAKER_COLORS[cls] ?? '#ff6b6b';
}

// ── Score visualization helpers ──────────────────────────────

function scoreToColor(rawScore: number): string {
  if (rawScore >= 0.8) return '#22dd66'; // bright green
  if (rawScore >= 0.5) return '#88cc22'; // yellow-green
  if (rawScore >= 0.2) return '#ccaa22'; // yellow
  if (rawScore > 0)    return '#dd6622'; // orange
  return '#dd2222';                       // red — no match
}

const TIER_COLORS: Record<CueTier, string> = {
  spk: '#22ddff', // cyan — highest confidence
  new: '#88cc44', // green — normal
  gap: '#cc8844', // amber — uncertain lead time
  mid: '#666666', // dim — captioner break, not matchable
};

// ── Shared helpers ───────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
}

export function generateSvg(
  waveform: WaveformData,
  cues: SubtitleCue[],
  speechRegions: SpeechRegion[],
  audioEdges: AudioEdge[],
  options: Partial<VizOptions> = {},
  speakerSegments?: SpeakerSegment[],
  scoredCues?: ScoredCue[],
): string {
  const pps = options.pixelsPerSecond ?? 50;
  const startTime = options.startTime ?? 0;
  const endTime = options.endTime ?? waveform.duration;
  const duration = endTime - startTime;
  const width = Math.ceil(duration * pps);

  // Build a lookup from cue index → ScoredCue (if scoring is available)
  const scoreMap = new Map<number, ScoredCue>();
  if (scoredCues) {
    for (const sc of scoredCues) {
      scoreMap.set(sc.cue.index, sc);
    }
  }

  // ── Layout ──
  const markerH = 22;
  const waveH = 100;
  const subH = 50;
  const onsH = 34;
  const vadH = 34;
  const gap = 6;
  const pad = 4;
  const labelW = 30;

  const topMarkerY = pad;
  const waveY = topMarkerY + markerH + gap;
  const subY = waveY + waveH + gap;
  const onsY = subY + subH + gap;
  const vadY = onsY + onsH + gap;
  const botMarkerY = vadY + vadH + gap;
  const totalH = botMarkerY + markerH + pad;

  const edgeOver = 4;

  const svg: string[] = [];

  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + labelW}" height="${totalH}"`,
    `  viewBox="0 0 ${width + labelW} ${totalH}"`,
    `  style="background:#0f0f1a">`,
  );

  svg.push('<defs>');
  svg.push(`<clipPath id="sub-clip"><rect x="${labelW}" y="${subY}" width="${width}" height="${subH}"/></clipPath>`);
  svg.push('</defs>');

  // ── Lane labels ──
  const ls = 'fill:#444;font-size:9px;font-family:monospace;font-weight:bold';
  svg.push(`<text x="2" y="${waveY + waveH / 2 + 3}" style="${ls}">WAV</text>`);
  svg.push(`<text x="2" y="${subY + subH / 2 + 3}" style="${ls}">SUB</text>`);
  svg.push(`<text x="2" y="${onsY + onsH / 2 + 3}" style="${ls}">ONS</text>`);
  svg.push(`<text x="2" y="${vadY + vadH / 2 + 3}" style="${ls}">${speakerSegments ? 'SPK' : 'VAD'}</text>`);

  // ── Lane backgrounds ──
  svg.push(`<rect x="${labelW}" y="${waveY}" width="${width}" height="${waveH}" fill="#0a0a14"/>`);
  svg.push(`<rect x="${labelW}" y="${subY}" width="${width}" height="${subH}" fill="#0d0d18"/>`);
  svg.push(`<rect x="${labelW}" y="${onsY}" width="${width}" height="${onsH}" fill="#0a0a14"/>`);
  svg.push(`<rect x="${labelW}" y="${vadY}" width="${width}" height="${vadH}" fill="#0d0d18"/>`);

  // ── Time markers ──
  const drawMarkers = (y: number) => {
    const lines: string[] = [];
    for (let t = Math.ceil(startTime / 10) * 10; t <= endTime; t += 10) {
      const x = labelW + (t - startTime) * pps;
      lines.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + markerH}" stroke="#444" stroke-width="1"/>`);
      lines.push(`<text x="${x + 3}" y="${y + markerH - 4}" fill="#666" font-size="9" font-family="monospace">${formatTime(t)}</text>`);
    }
    for (let t = Math.ceil(startTime); t <= endTime; t += 1) {
      if (t % 10 === 0) continue;
      const x = labelW + (t - startTime) * pps;
      lines.push(`<line x1="${x}" y1="${y + markerH * 0.55}" x2="${x}" y2="${y + markerH}" stroke="#282828" stroke-width="0.5"/>`);
    }
    if (pps >= 30) {
      for (let t = Math.ceil(startTime * 10) / 10; t <= endTime; t += 0.1) {
        if (Math.abs(t - Math.round(t)) < 0.001) continue;
        const x = labelW + (t - startTime) * pps;
        lines.push(`<line x1="${x}" y1="${y + markerH * 0.8}" x2="${x}" y2="${y + markerH}" stroke="#1a1a1a" stroke-width="0.3"/>`);
      }
    }
    return lines.join('\n');
  };

  svg.push(drawMarkers(topMarkerY));
  svg.push(drawMarkers(botMarkerY));

  // ═══ WAVEFORM ═══
  const windowsPerSec = 1 / waveform.windowSize;
  const startW = Math.max(0, Math.floor(startTime * windowsPerSec));
  const endW = Math.min(waveform.rms.length, Math.ceil(endTime * windowsPerSec));

  let maxRms = 0;
  for (let w = startW; w < endW; w++) { if (waveform.rms[w] > maxRms) maxRms = waveform.rms[w]; }
  if (maxRms === 0) maxRms = 1;

  const waveMid = waveY + waveH / 2;
  const pathParts: string[] = [];
  for (let w = startW; w < endW; w++) {
    const t = w * waveform.windowSize;
    const x = labelW + (t - startTime) * pps;
    const h = (waveform.rms[w] / maxRms) * (waveH * 0.9);
    if (h < 0.5) continue;
    const half = h / 2;
    pathParts.push(`M${x.toFixed(1)} ${(waveMid - half).toFixed(1)}V${(waveMid + half).toFixed(1)}`);
  }
  if (pathParts.length > 0) {
    const chunkSize = 5000;
    for (let i = 0; i < pathParts.length; i += chunkSize) {
      svg.push(`<path d="${pathParts.slice(i, i + chunkSize).join('')}" stroke="#00d4aa" stroke-width="${Math.max(0.5, pps * waveform.windowSize)}" opacity="0.75"/>`);
    }
  }

  // ═══ SUBTITLE CUES (with optional score visualization) ═══
  for (const cue of cues) {
    if (cue.end <= startTime || cue.start >= endTime) continue;
    const x1 = labelW + Math.max(0, (cue.start - startTime) * pps);
    const x2 = labelW + Math.min(width, (cue.end - startTime) * pps);
    const w = x2 - x1;
    if (w < 0.5) continue;

    const scored = scoreMap.get(cue.index);

    // Determine colors based on scoring
    const lineColor = scored ? scoreToColor(scored.rawScore) : '#4a9eff';
    const tierColor = scored ? TIER_COLORS[scored.classification.tier] : '#4a9eff';
    const lineOpacity = scored
      ? (scored.classification.tier === 'mid' ? 0.4 : 1.0)
      : 1.0;

    // Cue background fill
    svg.push(`<rect x="${x1.toFixed(1)}" y="${subY}" width="${w.toFixed(1)}" height="${subH}" fill="${lineColor}" opacity="0.08" rx="1"/>`);

    // Cue start edge — colored by proximity score
    svg.push(`<line x1="${x1.toFixed(1)}" y1="${subY - edgeOver}" x2="${x1.toFixed(1)}" y2="${subY + subH}" stroke="${lineColor}" stroke-width="2" opacity="${lineOpacity.toFixed(2)}"/>`);

    // Cue end edge
    svg.push(`<line x1="${x2.toFixed(1)}" y1="${subY}" x2="${x2.toFixed(1)}" y2="${subY + subH + edgeOver}" stroke="${lineColor}" stroke-width="1.5" opacity="0.4"/>`);

    // Cue text
    if (w > 30) {
      const text = cue.text.replace(/\n/g, ' ');
      const maxChars = Math.floor(w / 5.5);
      const truncated = text.length > maxChars ? text.slice(0, maxChars - 1) + '\u2026' : text;
      svg.push(`<text x="${(x1 + 4).toFixed(1)}" y="${subY + subH / 2 + 3}" fill="#a0c4ff" font-size="8" font-family="monospace" clip-path="url(#sub-clip)">${escapeXml(truncated)}</text>`);
    }

    // ── Score annotations (only when scoring data exists) ──
    if (scored) {
      // Score label above the cue start line
      const label = `${scored.rawScore.toFixed(2)} ${scored.classification.tier}`;
      const labelX = x1 + 2;
      const labelY = subY - edgeOver - 2;
      svg.push(`<text x="${labelX.toFixed(1)}" y="${labelY}" fill="${tierColor}" font-size="6" font-family="monospace" opacity="0.8">${label}</text>`);

      // Offset label (ms) below the score label
      const offsetLabel = `${scored.offsetMs >= 0 ? '+' : ''}${scored.offsetMs.toFixed(0)}ms`;
      svg.push(`<text x="${labelX.toFixed(1)}" y="${labelY - 7}" fill="#666" font-size="5" font-family="monospace">${offsetLabel}</text>`);

      // Connecting line from cue start → matched VAD start
      if (scored.nearestVadStart !== Infinity) {
        const vadX = labelW + (scored.nearestVadStart - startTime) * pps;
        // Only draw if the VAD start is within the visible window
        if (vadX >= labelW && vadX <= labelW + width) {
          // Thin dashed line from bottom of SUB lane to top of VAD/SPK lane
          svg.push(
            `<line x1="${x1.toFixed(1)}" y1="${subY + subH}"` +
            ` x2="${vadX.toFixed(1)}" y2="${vadY}"` +
            ` stroke="${lineColor}" stroke-width="0.5" opacity="0.25"` +
            ` stroke-dasharray="3,2"/>`,
          );
        }
      }
    }
  }

  // ═══ ONSET / SPEAKER CHANGE EDGES ═══
  for (const edge of audioEdges) {
    if (edge.time < startTime || edge.time > endTime) continue;
    const x = labelW + (edge.time - startTime) * pps;

    if (edge.type === 'onset') {
      svg.push(`<line x1="${x.toFixed(1)}" y1="${onsY - edgeOver}" x2="${x.toFixed(1)}" y2="${onsY + onsH}" stroke="#22dd66" stroke-width="2" opacity="${(0.4 + 0.6 * edge.strength).toFixed(2)}"/>`);
    } else {
      svg.push(`<line x1="${x.toFixed(1)}" y1="${onsY}" x2="${x.toFixed(1)}" y2="${onsY + onsH + edgeOver}" stroke="#ddaa22" stroke-width="1.5" opacity="${(0.3 + 0.5 * edge.strength).toFixed(2)}"/>`);
    }
  }

  // ═══ VAD / SPEAKER LANE ═══
  if (speakerSegments && speakerSegments.length > 0) {
    // Color-coded by speaker class
    for (const seg of speakerSegments) {
      if (seg.end <= startTime || seg.start >= endTime) continue;
      const x1 = labelW + Math.max(0, (seg.start - startTime) * pps);
      const x2 = labelW + Math.min(width, (seg.end - startTime) * pps);
      const w = x2 - x1;
      if (w < 0.3) continue;

      const color = speakerColor(seg.speaker);
      svg.push(`<rect x="${x1.toFixed(1)}" y="${vadY}" width="${w.toFixed(1)}" height="${vadH}" fill="${color}" opacity="0.3" rx="1"/>`);

      // Edges at speaker boundaries
      svg.push(`<line x1="${x1.toFixed(1)}" y1="${vadY - edgeOver}" x2="${x1.toFixed(1)}" y2="${vadY + vadH}" stroke="${color}" stroke-width="1.5"/>`);
    }
  } else {
    // Uniform speech regions (fallback for Silero/simple VAD)
    for (const region of speechRegions) {
      if (region.end <= startTime || region.start >= endTime) continue;
      const x1 = labelW + Math.max(0, (region.start - startTime) * pps);
      const x2 = labelW + Math.min(width, (region.end - startTime) * pps);
      const w = x2 - x1;
      if (w < 0.3) continue;

      svg.push(`<rect x="${x1.toFixed(1)}" y="${vadY}" width="${w.toFixed(1)}" height="${vadH}" fill="#ff6b6b" opacity="0.15" rx="1"/>`);
      svg.push(`<line x1="${x1.toFixed(1)}" y1="${vadY - edgeOver}" x2="${x1.toFixed(1)}" y2="${vadY + vadH}" stroke="#ff6b6b" stroke-width="2"/>`);
      svg.push(`<line x1="${x2.toFixed(1)}" y1="${vadY}" x2="${x2.toFixed(1)}" y2="${vadY + vadH}" stroke="#ff6b6b" stroke-width="1" opacity="0.5"/>`);
    }
  }

  // ── Lane dividers ──
  const dc = '#1a1a2a';
  svg.push(`<line x1="${labelW}" y1="${waveY}" x2="${width + labelW}" y2="${waveY}" stroke="${dc}" stroke-width="0.5"/>`);
  svg.push(`<line x1="${labelW}" y1="${subY}" x2="${width + labelW}" y2="${subY}" stroke="${dc}" stroke-width="0.5"/>`);
  svg.push(`<line x1="${labelW}" y1="${onsY}" x2="${width + labelW}" y2="${onsY}" stroke="${dc}" stroke-width="0.5"/>`);
  svg.push(`<line x1="${labelW}" y1="${vadY}" x2="${width + labelW}" y2="${vadY}" stroke="${dc}" stroke-width="0.5"/>`);
  svg.push(`<line x1="${labelW}" y1="${vadY + vadH}" x2="${width + labelW}" y2="${vadY + vadH}" stroke="${dc}" stroke-width="0.5"/>`);

  svg.push('</svg>');
  return svg.join('\n');
}
