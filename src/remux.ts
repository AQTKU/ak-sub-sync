import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import type { SegmentSearchResult } from './search.js';
import type { SubtitleTrack } from './types.js';

// ── Codec → extension mapping ────────────────────────────────

export function codecExtension(codec: string, codecId: string): string {
  const c = (codec + ' ' + codecId).toLowerCase();
  if (c.includes('subrip') || c.includes('srt') || c.includes('s_text/utf8')) return '.srt';
  if (c.includes('ass') || c.includes('ssa') || c.includes('s_text/ass')) return '.ass';
  if (c.includes('webvtt') || c.includes('s_text/webvtt')) return '.vtt';
  if (c.includes('vobsub') || c.includes('s_vobsub')) return '.sub';
  if (c.includes('pgs') || c.includes('hdmv') || c.includes('s_hdmv/pgs')) return '.sup';
  return '.sub';
}

// ── Correction types ─────────────────────────────────────────

export interface TrackCorrection {
  ratio: number;
  segments: SegmentSearchResult[];
  isUniform: boolean;
  uniformOffset?: number;
}

export type Corrector = (time: number) => number;

// ── Timestamp parsing / formatting ───────────────────────────

function parseSrtTs(ts: string): number {
  const m = ts.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function fmtSrtTs(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return (
    h.toString().padStart(2, '0') + ':' +
    m.toString().padStart(2, '0') + ':' +
    s.toString().padStart(2, '0') + ',' +
    ms.toString().padStart(3, '0')
  );
}

function parseAssTs(ts: string): number {
  const m = ts.trim().match(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
}

function fmtAssTs(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return (
    h + ':' +
    m.toString().padStart(2, '0') + ':' +
    s.toString().padStart(2, '0') + '.' +
    cs.toString().padStart(2, '0')
  );
}

// ── Timestamp correction ─────────────────────────────────────

export function buildCorrector(
  ratio: number,
  segments: SegmentSearchResult[],
  isUniform: boolean,
  uniformOffset?: number,
): Corrector {
  if (isUniform && uniformOffset !== undefined) {
    return (t: number) => t * ratio + uniformOffset;
  }

  const sorted = [...segments].sort((a, b) => a.segment.start - b.segment.start);

  return (t: number) => {
    for (const s of sorted) {
      if (t >= s.segment.start && t < s.segment.end) {
        return t * ratio + s.bestOffset;
      }
    }
    if (t < sorted[0].segment.start) {
      return t * ratio + sorted[0].bestOffset;
    }
    return t * ratio + sorted[sorted.length - 1].bestOffset;
  };
}

// ── Per-format adjustment ────────────────────────────────────

function adjustSrt(content: string, correct: Corrector): string {
  return content.replace(
    /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/g,
    (_m, startTs: string, endTs: string) => {
      return fmtSrtTs(correct(parseSrtTs(startTs))) +
        ' --> ' +
        fmtSrtTs(correct(parseSrtTs(endTs)));
    },
  );
}

function adjustAss(content: string, correct: Corrector): string {
  return content.split('\n').map(line => {
    if (!line.startsWith('Dialogue:') && !line.startsWith('Comment:')) {
      return line;
    }
    const comma1 = line.indexOf(',');
    const comma2 = line.indexOf(',', comma1 + 1);
    const comma3 = line.indexOf(',', comma2 + 1);
    if (comma1 === -1 || comma2 === -1 || comma3 === -1) return line;

    const prefix = line.slice(0, comma1 + 1);
    const startTs = line.slice(comma1 + 1, comma2);
    const endTs = line.slice(comma2 + 1, comma3);
    const suffix = line.slice(comma3);

    return prefix +
      fmtAssTs(correct(parseAssTs(startTs))) + ',' +
      fmtAssTs(correct(parseAssTs(endTs))) +
      suffix;
  }).join('\n');
}

function adjustVtt(content: string, correct: Corrector): string {
  return content.replace(
    /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/g,
    (_m, startTs: string, endTs: string) => {
      const s = correct(parseSrtTs(startTs.replace('.', ',')));
      const e = correct(parseSrtTs(endTs.replace('.', ',')));
      return fmtSrtTs(s).replace(',', '.') + ' --> ' + fmtSrtTs(e).replace(',', '.');
    },
  );
}

export function adjustContent(content: string, ext: string, correct: Corrector): string {
  switch (ext) {
    case '.srt': return adjustSrt(content, correct);
    case '.ass': return adjustAss(content, correct);
    case '.vtt': return adjustVtt(content, correct);
    default: return content;
  }
}

// ── Overlap fixing ──────────────────────────────────────────

function getPositionKey(text: string): string {
  const pos = text.match(/\{[^}]*\\pos\(([^)]+)\)[^}]*\}/);
  if (pos) return `pos:${pos[1]}`;
  const an = text.match(/\{[^}]*\\an(\d)[^}]*\}/);
  if (an) return `an:${an[1]}`;
  return '';
}

function fixSrtOverlaps(content: string): string {
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\n+/);

  interface Entry {
    start: number;
    end: number;
    textLines: string;
    posKey: string;
  }

  const entries: Entry[] = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const tcIdx = lines.findIndex(l => l.includes('-->'));
    if (tcIdx === -1) continue;

    const [startStr, endStr] = lines[tcIdx].split('-->');
    if (!startStr || !endStr) continue;

    const textLines = lines.slice(tcIdx + 1).join('\n');
    entries.push({
      start: parseSrtTs(startStr),
      end: parseSrtTs(endStr),
      textLines,
      posKey: getPositionKey(textLines),
    });
  }

  if (entries.length < 2) return content;

  entries.sort((a, b) => a.start - b.start);

  let anyFixed = false;
  for (let i = 0; i < entries.length; i++) {
    const curr = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].posKey !== curr.posKey) continue;
      if (curr.end > entries[j].start) {
        const fixed = entries[j].start - 0.001;
        if (fixed > curr.start) {
          curr.end = fixed;
          anyFixed = true;
        }
      }
      break;
    }
  }

  if (!anyFixed) return content;

  return entries.map((e, i) =>
    `${i + 1}\n${fmtSrtTs(e.start)} --> ${fmtSrtTs(e.end)}\n${e.textLines}`
  ).join('\n\n') + '\n';
}

function fixAssOverlaps(content: string): string {
  const lines = content.split('\n');

  interface DialogueInfo {
    lineIndex: number;
    start: number;
    end: number;
    posKey: string;
  }

  const dialogues: DialogueInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('Dialogue:')) continue;

    const comma1 = line.indexOf(',');
    const comma2 = line.indexOf(',', comma1 + 1);
    const comma3 = line.indexOf(',', comma2 + 1);
    if (comma1 === -1 || comma2 === -1 || comma3 === -1) continue;

    let commaCount = 0;
    let textStart = 0;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === ',') {
        commaCount++;
        if (commaCount === 9) { textStart = j + 1; break; }
      }
    }

    const text = line.slice(textStart);
    dialogues.push({
      lineIndex: i,
      start: parseAssTs(line.slice(comma1 + 1, comma2)),
      end: parseAssTs(line.slice(comma2 + 1, comma3)),
      posKey: getPositionKey(text),
    });
  }

  if (dialogues.length < 2) return content;

  const sorted = [...dialogues].sort((a, b) => a.start - b.start);

  let anyFixed = false;
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].posKey !== curr.posKey) continue;
      if (curr.end > sorted[j].start) {
        const fixed = sorted[j].start - 0.01;
        if (fixed > curr.start) {
          curr.end = fixed;
          const line = lines[curr.lineIndex];
          const c1 = line.indexOf(',');
          const c2 = line.indexOf(',', c1 + 1);
          const c3 = line.indexOf(',', c2 + 1);
          lines[curr.lineIndex] =
            line.slice(0, c2 + 1) + fmtAssTs(fixed) + line.slice(c3);
          anyFixed = true;
        }
      }
      break;
    }
  }

  if (!anyFixed) return content;
  return lines.join('\n');
}

export function fixOverlaps(content: string, ext: string): string {
  switch (ext) {
    case '.srt': return fixSrtOverlaps(content);
    case '.ass': return fixAssOverlaps(content);
    default: return content;
  }
}

// ── Subtitle preparation for muxing ─────────────────────────

export function prepareAdjustedSubtitle(
  track: SubtitleTrack,
  corrector: Corrector | null,
  tempDir: string,
): string {
  if (track.sourceType === 'standalone') {
    if (!track.isText) return track.sourcePath;
    if (!corrector) return track.sourcePath;
    const ext = extname(track.sourcePath).toLowerCase();
    let content = readFileSync(track.sourcePath, 'utf-8');
    content = adjustContent(content, ext, corrector);
    content = fixOverlaps(content, ext);
    const outPath = join(tempDir, `sub-${track.id}${ext}`);
    writeFileSync(outPath, content);
    return outPath;
  }

  // Container-embedded: extract native format via mkvextract
  const ext = codecExtension(track.codec, track.codecId);
  const extractPath = join(tempDir, `sub-${track.id}-raw${ext}`);
  execFileSync('mkvextract', [
    'tracks', track.sourcePath, `${track.containerTrackId}:${extractPath}`,
  ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  if (!track.isText) return extractPath;

  let content = readFileSync(extractPath, 'utf-8');
  if (corrector) {
    content = adjustContent(content, ext, corrector);
  }
  content = fixOverlaps(content, ext);
  const outPath = join(tempDir, `sub-${track.id}${ext}`);
  writeFileSync(outPath, content);
  return outPath;
}

// ── Container muxing ────────────────────────────────────────

export interface MuxSubtitle {
  path: string;
  language: string;
  languageIetf?: string;
  trackName?: string;
  forced: boolean;
  hearingImpaired: boolean;
  defaultTrack: boolean;
}

export function muxToContainer(opts: {
  outputPath: string;
  videoSource?: string;
  audioSources: string[];
  subtitles: MuxSubtitle[];
}): void {
  const args: string[] = ['-o', opts.outputPath];

  // Collect unique container sources and what to include from each
  const sources = new Map<string, { includeVideo: boolean; includeAudio: boolean }>();

  if (opts.videoSource) {
    const s = sources.get(opts.videoSource) ?? { includeVideo: false, includeAudio: false };
    s.includeVideo = true;
    sources.set(opts.videoSource, s);
  }

  for (const audioSrc of opts.audioSources) {
    const s = sources.get(audioSrc) ?? { includeVideo: false, includeAudio: false };
    s.includeAudio = true;
    sources.set(audioSrc, s);
  }

  // Add each container source once with appropriate track selection
  for (const [path, include] of sources) {
    if (!include.includeVideo) args.push('--no-video');
    if (!include.includeAudio) args.push('--no-audio');
    args.push('--no-subtitles');
    args.push(path);
  }

  // Add subtitle files with metadata
  for (const sub of opts.subtitles) {
    const lang = sub.languageIetf ?? sub.language;
    if (lang && lang !== 'und') {
      args.push('--language', `0:${lang}`);
    }
    if (sub.trackName) {
      args.push('--track-name', `0:${sub.trackName}`);
    }
    args.push('--hearing-impaired-flag', `0:${sub.hearingImpaired ? 1 : 0}`);
    args.push('--forced-display-flag', `0:${sub.forced ? 1 : 0}`);
    args.push('--default-track-flag', `0:${sub.defaultTrack ? 1 : 0}`);
    args.push(sub.path);
  }

  execFileSync('mkvmerge', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024,
  });
}
