import { execFileSync } from 'child_process';
import { extname, basename } from 'path';
import type {
  VideoSource, AudioSource, SubtitleTrack, CollectedInput, OutputType, Chapter,
} from './types.js';

// ── File classification ─────────────────────────────────────

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const CONTAINER_EXTENSIONS = new Set([
  '.mkv', '.mka', '.mks', '.webm',
  '.mp4', '.m4v', '.m4a', '.mov',
  '.avi', '.ts', '.flv',
]);
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'tiff']);

export function classifyFile(path: string): 'subtitle' | 'container' {
  const ext = extname(path).toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  if (CONTAINER_EXTENSIONS.has(ext)) return 'container';
  throw new Error(`Unsupported file type: ${ext} (${basename(path)})`);
}

export function getOutputType(outputPath: string): OutputType {
  const ext = extname(outputPath).toLowerCase();
  switch (ext) {
    case '.svg': return 'svg';
    case '.mkv': return 'mkv';
    case '.mka': return 'mka';
    case '.mks': return 'mks';
    case '.srt': return 'srt';
    default: throw new Error(`Unsupported output format: ${ext}`);
  }
}

// ── Subtitle filename metadata ──────────────────────────────

export interface FilenameMetadata {
  language?: string;
  forced: boolean;
  hearingImpaired: boolean;
}

// IETF language tag patterns, most specific → least
const LANG_PATTERNS: RegExp[] = [
  /^[a-z]{2,3}-[a-z]{4}-(?:[a-z]{2}|\d{3})$/i,  // zh-Hant-HK, zh-Hans-CN
  /^[a-z]{2,3}-[a-z]{4}$/i,                        // zh-Hans, zh-Hant
  /^[a-z]{2,3}-(?:[a-z]{2}|\d{3})$/i,              // en-CA, es-419
  /^[a-z]{3}$/i,                                     // eng, spa
  /^[a-z]{2}$/i,                                     // en, es
];

function isLanguageTag(segment: string): boolean {
  return LANG_PATTERNS.some(p => p.test(segment));
}

function isFlagTag(segment: string): 'forced' | 'hearingImpaired' | null {
  const lower = segment.toLowerCase();
  if (lower === 'forced') return 'forced';
  if (lower === 'sdh' || lower === 'cc') return 'hearingImpaired';
  return null;
}

export function parseSubtitleFilename(filename: string): FilenameMetadata {
  const result: FilenameMetadata = { forced: false, hearingImpaired: false };
  const ext = extname(filename);
  const stem = basename(filename, ext);
  const segments = stem.split('.');

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    // Check flags before language (avoids "sdh" matching as a 3-letter lang code)
    const flag = isFlagTag(seg);
    if (flag) {
      result[flag] = true;
      continue;
    }
    if (isLanguageTag(seg)) {
      result.language = seg;
      continue;
    }
    break;
  }

  return result;
}

// ── Container probing ───────────────────────────────────────

interface FFProbeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  channels?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: { language?: string };
  disposition?: { default?: number };
}

function parseFrameRate(rate?: string): number {
  if (!rate || rate === '0/0') return 23.976;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return num / den;
  }
  const parsed = parseFloat(rate);
  return parsed > 0 ? parsed : 23.976;
}

const TEXT_CODEC_PATTERNS = [
  'subrip', 'srt', 's_text/utf8',
  'ass', 'ssa', 's_text/ass',
  'webvtt', 's_text/webvtt',
];

function isTextCodec(codec: string, codecId: string): boolean {
  const c = (codec + ' ' + codecId).toLowerCase();
  return TEXT_CODEC_PATTERNS.some(p => c.includes(p));
}

export function probeContainer(path: string): {
  videoTracks: VideoSource[];
  audioTracks: AudioSource[];
  subtitleTracks: SubtitleTrack[];
  duration: number;
} {
  const probe = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', path,
  ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const data = JSON.parse(probe);
  const streams: FFProbeStream[] = data.streams ?? [];
  const duration = parseFloat(data.format?.duration ?? '0');

  const videoTracks: VideoSource[] = [];
  const audioTracks: AudioSource[] = [];

  for (const s of streams) {
    if (s.codec_type === 'video' && !IMAGE_CODECS.has(s.codec_name)) {
      videoTracks.push({
        sourcePath: path,
        streamIndex: s.index,
        fps: parseFrameRate(s.r_frame_rate ?? s.avg_frame_rate),
      });
    } else if (s.codec_type === 'audio') {
      audioTracks.push({
        sourcePath: path,
        streamIndex: s.index,
        language: s.tags?.language ?? 'und',
        channels: s.channels ?? 2,
        defaultTrack: !!(s.disposition?.default),
      });
    }
  }

  // mkvmerge -J for rich subtitle track metadata (IETF language, flags)
  const subtitleTracks: SubtitleTrack[] = [];
  try {
    const json = execFileSync(
      'mkvmerge', ['-J', path],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    const mkvData = JSON.parse(json);
    let subIndex = 0;
    for (const track of mkvData.tracks ?? []) {
      if (track.type !== 'subtitles') continue;
      const p = track.properties ?? {};
      const codec = track.codec ?? '';
      const codecId = p.codec_id ?? '';
      subtitleTracks.push({
        id: -1, // assigned by collectInputs
        sourcePath: path,
        sourceType: 'container',
        relativeSubIndex: subIndex++,
        containerTrackId: track.id,
        codec,
        codecId,
        language: p.language ?? 'und',
        languageIetf: p.language_ietf ?? undefined,
        trackName: p.track_name ?? undefined,
        forced: p.forced_track ?? false,
        hearingImpaired: p.flag_hearing_impaired ?? false,
        defaultTrack: p.default_track ?? false,
        isText: isTextCodec(codec, codecId),
      });
    }
  } catch {
    // mkvmerge unavailable or unsupported format — fall back to ffprobe
    let subIndex = 0;
    for (const s of streams) {
      if (s.codec_type !== 'subtitle') continue;
      subtitleTracks.push({
        id: -1,
        sourcePath: path,
        sourceType: 'container',
        relativeSubIndex: subIndex++,
        containerTrackId: s.index,
        codec: s.codec_name ?? '',
        codecId: '',
        language: s.tags?.language ?? 'und',
        forced: false,
        hearingImpaired: false,
        defaultTrack: false,
        isText: true,
      });
    }
  }

  return { videoTracks, audioTracks, subtitleTracks, duration };
}

// ── Chapter extraction ──────────────────────────────────────

export function extractChapters(path: string): Chapter[] {
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_chapters', path,
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const data = JSON.parse(probe);

    const chapters: Chapter[] = [];
    for (const ch of data.chapters || []) {
      const endTime = parseFloat(ch.end_time);
      chapters.push({
        start: parseFloat(ch.start_time),
        end: isNaN(endTime) ? Infinity : endTime,
        name: ch.tags?.title || '',
      });
    }
    return chapters;
  } catch {
    return [];
  }
}

// ── Standalone subtitle ─────────────────────────────────────

function subtitleCodecFromExt(ext: string): { codec: string; codecId: string } {
  switch (ext.toLowerCase()) {
    case '.srt': return { codec: 'SubRip/SRT', codecId: 'S_TEXT/UTF8' };
    case '.ass': case '.ssa': return { codec: 'SubStationAlpha', codecId: 'S_TEXT/ASS' };
    case '.vtt': return { codec: 'WebVTT', codecId: 'S_TEXT/WEBVTT' };
    default: return { codec: 'unknown', codecId: 'unknown' };
  }
}

function createStandaloneSubtitleTrack(path: string): SubtitleTrack {
  const ext = extname(path).toLowerCase();
  const meta = parseSubtitleFilename(basename(path));
  const { codec, codecId } = subtitleCodecFromExt(ext);

  return {
    id: -1,
    sourcePath: path,
    sourceType: 'standalone',
    relativeSubIndex: -1,
    containerTrackId: -1,
    codec,
    codecId,
    language: meta.language ?? 'und',
    languageIetf: meta.language,
    trackName: undefined,
    forced: meta.forced,
    hearingImpaired: meta.hearingImpaired,
    defaultTrack: false,
    isText: true,
  };
}

// ── Collect and validate ────────────────────────────────────

export function collectInputs(paths: string[]): CollectedInput {
  const allVideo: VideoSource[] = [];
  const allAudio: AudioSource[] = [];
  const allSubs: SubtitleTrack[] = [];
  let duration = 0;
  let nextId = 0;

  for (const p of paths) {
    const type = classifyFile(p);

    if (type === 'subtitle') {
      const track = createStandaloneSubtitleTrack(p);
      track.id = nextId++;
      allSubs.push(track);
    } else {
      const result = probeContainer(p);
      allVideo.push(...result.videoTracks);
      allAudio.push(...result.audioTracks);
      for (const sub of result.subtitleTracks) {
        sub.id = nextId++;
        allSubs.push(sub);
      }
      if (result.duration > duration) duration = result.duration;
    }
  }

  if (allVideo.length > 1) {
    throw new Error(`Expected 0–1 video tracks, found ${allVideo.length}`);
  }
  if (allAudio.length === 0) {
    throw new Error('No audio tracks found');
  }
  if (allSubs.length === 0) {
    throw new Error('No subtitle tracks found');
  }

  // Select audio: prefer default track, then earliest stream index
  allAudio.sort((a, b) => {
    if (a.defaultTrack !== b.defaultTrack) return a.defaultTrack ? -1 : 1;
    return a.streamIndex - b.streamIndex;
  });

  return {
    video: allVideo[0],
    audio: allAudio[0],
    audioTracks: allAudio,
    subtitles: allSubs,
    duration,
    fps: allVideo[0]?.fps ?? 23.976,
  };
}

// ── SRT output path expansion ───────────────────────────────

export function subtitleFileSuffix(track: SubtitleTrack): string {
  const parts: string[] = [];
  const lang = track.languageIetf ?? track.language;
  if (lang && lang !== 'und') parts.push(lang);
  if (track.hearingImpaired) parts.push('sdh');
  if (track.forced) parts.push('forced');
  return parts.join('.');
}

export function expandSrtOutputPaths(
  basePath: string,
  tracks: SubtitleTrack[],
): Map<number, string> {
  if (tracks.length === 1) {
    return new Map([[tracks[0].id, basePath]]);
  }

  const ext = extname(basePath);
  const stem = basePath.slice(0, basePath.length - ext.length);
  const result = new Map<number, string>();
  const usedPaths = new Set<string>();

  for (const track of tracks) {
    const suffix = subtitleFileSuffix(track);
    let candidate = suffix ? `${stem}.${suffix}${ext}` : basePath;

    let n = 2;
    while (usedPaths.has(candidate)) {
      candidate = suffix
        ? `${stem}.${suffix}.${n}${ext}`
        : `${stem}.${n}${ext}`;
      n++;
    }

    usedPaths.add(candidate);
    result.set(track.id, candidate);
  }

  return result;
}
