import { resolve, dirname, basename, join, extname } from 'path';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { collectInputs, getOutputType, expandSrtOutputPaths, classifyFile, extractChapters } from './input.js';
import { extractAudio, extractSubtitle, convertToSrt } from './extract.js';
import { parseSrt, cleanCues } from './srt.js';
import { computeWaveform } from './waveform.js';
import { scoreCues, scoreSummary } from './score.js';
import {
  searchBestAlignment, adjustCues, describeRatio,
  searchSegmented, adjustCuesSegmented,
  type SegmentSearchResult,
} from './search.js';
import {
  findSilenceRuns, buildSegments,
  silenceRunsToSplitPoints, findCueGapSplits, findChapterSplits,
} from './segment.js';
import {
  buildCorrector, adjustContent, fixOverlaps,
  muxToContainer, prepareAdjustedSubtitle,
  type Corrector, type MuxSubtitle,
} from './remux.js';
import type { ScoredCue } from './score.js';
import type { SubtitleCue, SubtitleTrack, OutputType } from './types.js';

// ── Arg parsing ──────────────────────────────────────────────

function parseArgs(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();

  const BOOL_FLAGS = new Set(['segment-on-chapters']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOL_FLAGS.has(name)) {
        boolFlags.add(name);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[name] = args[++i];
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    positional,
    output: flags.output,
    fps: flags.fps ? parseFloat(flags.fps) : undefined,
    segmentOnSilence: flags['segment-on-silence'] !== undefined
      ? parseFloat(flags['segment-on-silence'])
      : 1.5,
    segmentOnCueGap: flags['segment-on-cue-gap'] !== undefined
      ? parseFloat(flags['segment-on-cue-gap'])
      : 0,
    segmentOnChapters: boolFlags.has('segment-on-chapters'),
    minSegment: flags['min-segment'] ? parseFloat(flags['min-segment']) : 300,
    svgStart: flags['svg-start'] ? parseFloat(flags['svg-start']) : undefined,
    svgEnd: flags['svg-end'] ? parseFloat(flags['svg-end']) : undefined,
    svgScale: flags['svg-scale'] ? parseFloat(flags['svg-scale']) : 50,
  };
}

const opts = parseArgs(process.argv.slice(2));

if (opts.positional.length === 0) {
  console.log(`
  ak-sub-sync — subtitle alignment tool

  Usage:
    npx tsx src/cli.ts <file1> [file2 ...] [--output <path>] [options]

  Inputs:
    Any mix of container files (.mkv, .mka, .mks, ...) and subtitle
    files (.srt, .ass, .vtt). Accepts 0–1 video, exactly 1 audio,
    and 1+ subtitle tracks across all inputs.

    Subtitle filenames are parsed for metadata from the end:
      show.en-CA.srt         → language: en-CA
      show.es.forced.srt     → language: es, forced
      show.en.sdh.srt        → language: en, hearing-impaired

  Output:
    Without --output, muxes to a Matroska container alongside the
    first input file (.mkv if video present, .mka otherwise). If
    this would overwrite an input, the original is backed up to
    an unsynced/ folder.

    --output file.svg        SVG visualization only
    --output file.mkv        Mux video + audio + aligned subtitles
    --output file.mka        Mux audio + aligned subtitles (no video)
    --output file.mks        Aligned subtitles only (Matroska container)
    --output file.srt        Write aligned .srt files

  Segmentation:
    --segment-on-silence <s> Split on silence runs (default: 1.5, 0 to disable)
    --segment-on-cue-gap <s> Split on subtitle cue gaps (default: 0 = disabled)
    --segment-on-chapters    Split on chapter boundaries (from ffprobe)
    --min-segment <sec>      Minimum segment length (default: 300, 0 to disable)

  Options:
    --fps <rate>             Video frame rate (default: from video stream)
    --svg-start <sec>        SVG start time in seconds (default: 0)
    --svg-end <sec>          SVG end time in seconds (default: file duration)
    --svg-scale <px/s>       SVG pixels per second (default: 50)

  VAD: pyannote segmentation-3.0
  `);
  process.exit(1);
}

// ── Resolve inputs ──────────────────────────────────────────

console.log(`\n  ak-sub-sync`);
console.log(`  ───────────`);

const inputPaths = opts.positional.map(p => resolve(p));
const input = collectInputs(inputPaths);
const fps = opts.fps ?? input.fps;
const t0 = Date.now();

// ── Determine output ────────────────────────────────────────

let outputPath: string;
let outputType: OutputType;

if (opts.output) {
  outputPath = resolve(opts.output);
  outputType = getOutputType(outputPath);
} else {
  const dir = dirname(inputPaths[0]);
  const stem = basename(inputPaths[0]).replace(/\.[^.]+$/, '');
  const ext = input.video ? '.mkv' : '.mka';
  outputPath = join(dir, stem + ext);
  outputType = ext.slice(1) as OutputType;
}

// ── Input summary ──

console.log(`  Inputs: ${inputPaths.length} file${inputPaths.length !== 1 ? 's' : ''}`);

if (input.video) {
  console.log(`    Video: ${basename(input.video.sourcePath)} (stream ${input.video.streamIndex})`);
}

if (input.audioTracks.length > 1) {
  console.log(`    Audio: ${input.audioTracks.length} tracks`);
  for (const a of input.audioTracks) {
    const sel = a === input.audio ? ' ← selected' : '';
    const def = a.defaultTrack ? ' [default]' : '';
    console.log(`      stream ${a.streamIndex}: ${a.language}${def}${sel}`);
  }
} else {
  console.log(`    Audio: ${basename(input.audio.sourcePath)} (stream ${input.audio.streamIndex}, lang: ${input.audio.language})`);
}
console.log(`    FPS: ${fps}${opts.fps ? ' (override)' : ' (detected)'}`);
console.log(`    Duration: ${(input.duration / 60).toFixed(1)} min`);

const textTracks = input.subtitles.filter(t => t.isText);
const bitmapCount = input.subtitles.length - textTracks.length;

console.log(`    Subtitles: ${input.subtitles.length} track${input.subtitles.length !== 1 ? 's' : ''}` +
  ` (${textTracks.length} text${bitmapCount > 0 ? `, ${bitmapCount} bitmap` : ''})`);

for (const track of input.subtitles) {
  const label = trackLabel(track);
  const flags = trackFlags(track);
  const src = track.sourceType === 'standalone' ? basename(track.sourcePath) : `${basename(track.sourcePath)} #${track.containerTrackId}`;
  console.log(`      [${track.id}] ${src} — ${label}${flags} [${track.codec}]${track.isText ? '' : ' — bitmap'}`);
}

console.log(`  Output: ${basename(outputPath)} (${outputType})`);
console.log('');

if (textTracks.length === 0) {
  console.log('  No text subtitle tracks found. Nothing to align.\n');
  process.exit(0);
}

// ── Group by language & select alignment references ──

const languageGroups = groupByLanguage(textTracks);
const trackAlignmentRef = new Map<number, SubtitleTrack>();

for (const track of textTracks) {
  trackAlignmentRef.set(track.id, selectAlignmentRef(track, textTracks, languageGroups, input.audio.language));
}

const uniqueRefIds = [...new Set([...trackAlignmentRef.values()].map(t => t.id))];

// ── Step 1: Extract audio ──

console.log('  [1/3] Extracting audio → waveform...');
const pcmPath = extractAudio(input.audio.sourcePath, input.audio.streamIndex);

// ── Step 2: Compute waveform ──

console.log('  [2/3] Computing waveform...');
const displayWaveform = computeWaveform(pcmPath);

// ── Step 3: VAD ──

console.log('  [3/3] Running VAD (pyannote segmentation-3.0)...');
const { runPyannoteVad } = await import('./pyannote-vad.js');
const vadResult = await runPyannoteVad(pcmPath);
const { speechRegions, speakerSegments, speakerChanges } = vadResult;

console.log(`    ${speechRegions.length} speech regions`);
console.log(`    ${speakerSegments.length} speaker segments`);
console.log(`    ${speakerChanges.length} speaker changes`);
console.log('');

// ── Segmentation ──

const alignmentResults = new Map<number, AlignmentResult>();
const tempFiles: string[] = [];
const srtPathCache = new Map<number, string>();

function getSrtPath(track: SubtitleTrack): string {
  if (srtPathCache.has(track.id)) return srtPathCache.get(track.id)!;

  let srtPath: string;
  if (track.sourceType === 'standalone') {
    const ext = extname(track.sourcePath).toLowerCase();
    if (ext === '.srt') {
      srtPath = track.sourcePath;
    } else {
      srtPath = convertToSrt(track.sourcePath);
      tempFiles.push(srtPath);
    }
  } else {
    srtPath = extractSubtitle(track.sourcePath, track.relativeSubIndex);
    tempFiles.push(srtPath);
  }

  srtPathCache.set(track.id, srtPath);
  return srtPath;
}

console.log('  Segmentation...');
const splitPoints: number[] = [];

if (opts.segmentOnSilence > 0) {
  const silenceRuns = findSilenceRuns(displayWaveform, {
    minSilenceSec: opts.segmentOnSilence,
  });
  console.log(`    Silence: ${silenceRuns.length} runs ≥ ${opts.segmentOnSilence}s`);
  splitPoints.push(...silenceRunsToSplitPoints(silenceRuns));
}

if (opts.segmentOnCueGap > 0 && textTracks.length > 0) {
  const primaryRef = textTracks.find(t => t.id === uniqueRefIds[0])!;
  const gapSrtPath = getSrtPath(primaryRef);
  const gapCues = parseSrt(gapSrtPath);
  const gapSplits = findCueGapSplits(gapCues, opts.segmentOnCueGap);
  console.log(`    Cue gaps: ${gapSplits.length} gaps ≥ ${opts.segmentOnCueGap}s`);
  splitPoints.push(...gapSplits);
}

if (opts.segmentOnChapters) {
  const containerPaths = [...new Set(
    inputPaths.filter(p => classifyFile(p) === 'container')
  )];
  const allChapters: { start: number; end: number; name: string }[] = [];
  for (const cp of containerPaths) {
    allChapters.push(...extractChapters(cp));
  }
  const seen = new Set<number>();
  const uniqueChapters = allChapters.filter(ch => {
    const key = +ch.start.toFixed(3);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chapterSplits = findChapterSplits(uniqueChapters);
  console.log(`    Chapters: ${uniqueChapters.length} found → ${chapterSplits.length} split points`);
  for (const ch of uniqueChapters) {
    console.log(`      ${fmtTime(ch.start)} ${ch.name}`);
  }
  splitPoints.push(...chapterSplits);
}

if (splitPoints.length === 0 && opts.segmentOnSilence === 0 && !opts.segmentOnChapters && opts.segmentOnCueGap === 0) {
  console.log('    All segmentation disabled — single segment');
}

const segments = buildSegments(splitPoints, input.duration, opts.minSegment);
console.log(`    ${segments.length} segment${segments.length !== 1 ? 's' : ''}${opts.minSegment > 0 ? ` (min ${opts.minSegment}s)` : ''}`);
for (const seg of segments) {
  const dur = seg.end - seg.start;
  console.log(
    `      [${seg.index}] ${fmtTime(seg.start)} → ${fmtTime(seg.end)}` +
    ` (${(dur / 60).toFixed(1)} min)`,
  );
}
console.log('');

// ── Per-language alignment ──

interface AlignmentResult {
  ratio: number;
  segments: SegmentSearchResult[];
  isUniform: boolean;
  uniformOffset?: number;
  vizCues: SubtitleCue[];
  scored?: ScoredCue[];
}

console.log(`  Aligning subtitles (${uniqueRefIds.length} pass${uniqueRefIds.length !== 1 ? 'es' : ''})...`);

for (let passIdx = 0; passIdx < uniqueRefIds.length; passIdx++) {
  const refId = uniqueRefIds[passIdx];
  const refTrack = textTracks.find(t => t.id === refId)!;
  const refLabel = trackLabel(refTrack);
  const refFlags = trackFlags(refTrack);
  const dependentTracks = textTracks.filter(t => trackAlignmentRef.get(t.id)?.id === refId);
  const dependentLangs = [...new Set(dependentTracks.map(t => langKey(t)))];

  console.log(`\n  ── [${passIdx + 1}/${uniqueRefIds.length}] ${dependentLangs.join(', ')} ──`);
  console.log(`    Reference: [${refTrack.id}] ${refLabel}${refFlags}`);

  const srtPath = getSrtPath(refTrack);
  const rawCues = parseSrt(srtPath);
  const cues = cleanCues(rawCues);
  const stripped = rawCues.length - cues.length;
  console.log(`    ${rawCues.length} cues parsed${stripped > 0 ? `, ${stripped} empty after cleaning` : ''}`);
  console.log(`    ${cues.length} cues for scoring`);

  if (cues.length === 0) {
    console.log(`    ⚠ No cues to align, skipping`);
    continue;
  }

  const searchConfig = {
    frameRate: fps,
    scoreConfig: { frameRate: fps },
  };

  let result: AlignmentResult;

  if (speakerSegments && speakerSegments.length > 0) {
    if (segments.length === 1) {
      console.log(`    Searching whole file (fps: ${fps})...`);
      const search = searchBestAlignment(
        cues, speakerSegments, speakerChanges, searchConfig,
      );

      printSearchResult(search);

      const isIdentity =
        Math.abs(search.bestRatio - 1.0) < 1e-6 &&
        Math.abs(search.bestOffset) < 0.001;

      const vizCues = isIdentity ? cues : adjustCues(cues, search.bestRatio, search.bestOffset);

      result = {
        ratio: search.bestRatio,
        segments: [{
          segment: segments[0],
          bestOffset: search.bestOffset,
          bestScore: search.bestScore,
          cueCount: cues.length,
        }],
        isUniform: true,
        uniformOffset: search.bestOffset,
        vizCues,
      };
    } else {
      console.log(`    Searching ${segments.length} segments (fps: ${fps})...`);
      const search = searchSegmented(
        segments, cues, speakerSegments, speakerChanges, searchConfig,
      );

      console.log(`    ${search.totalIterations.toLocaleString()} combinations in ${search.elapsedMs.toFixed(0)}ms`);
      console.log(`    Ratio: ${search.ratioLabel} (${search.ratio.toFixed(6)})`);
      console.log(`    Total score: ${search.totalScore.toFixed(2)}`);

      if (search.ratioCompetition.length > 1) {
        console.log('    Ratio competition (nearby cluster):');
        for (const rc of search.ratioCompetition) {
          const marker = rc.ratio === search.ratio ? ' ← winner' : '';
          console.log(
            `      ${rc.label.padEnd(14)} ` +
            `total=${rc.totalScore.toFixed(2).padStart(8)}` +
            `${marker}`,
          );
        }
      }
      console.log('');

      console.log('    Per-segment offsets:');
      for (const sr of search.segments) {
        const sign = sr.bestOffset >= 0 ? '+' : '';
        console.log(
          `      [${sr.segment.index}] ` +
          `offset=${sign}${(sr.bestOffset * 1000).toFixed(1)}ms ` +
          `score=${sr.bestScore.toFixed(2)} ` +
          `(${sr.cueCount} cues)`,
        );
      }
      console.log('');

      if (search.isUniform) {
        const sign = search.uniformOffset! >= 0 ? '+' : '';
        console.log(`    Offsets are uniform (max deviation < 100ms)`);
        console.log(`    Using single offset: ${sign}${(search.uniformOffset! * 1000).toFixed(1)}ms`);
      } else {
        console.log(`    Offsets vary — applying per-segment corrections`);
      }

      result = {
        ratio: search.ratio,
        segments: search.segments,
        isUniform: search.isUniform,
        uniformOffset: search.uniformOffset,
        vizCues: adjustCuesSegmented(cues, search),
      };
    }

    result.scored = scoreCues(result.vizCues, speakerSegments, speakerChanges, {
      frameRate: fps,
    });

    const summary = scoreSummary(result.scored);
    console.log(`    Scoring at best alignment:`);
    console.log(`      Total weighted score: ${summary.totalWeightedScore.toFixed(2)}`);
    console.log(`      Mean raw score:       ${summary.meanRawScore.toFixed(3)}`);
    console.log(`      Tiers: spk=${summary.tierCounts.spk} new=${summary.tierCounts.new} gap=${summary.tierCounts.gap} mid=${summary.tierCounts.mid}`);
  }

  alignmentResults.set(refId, result!);
}

// Log tracks that borrow alignment from another language
for (const track of textTracks) {
  const ref = trackAlignmentRef.get(track.id)!;
  if (ref.id !== track.id && langKey(ref) !== langKey(track)) {
    console.log(`\n    ${langKey(track)} [${track.id}] (${trackLabel(track)}) → using alignment from ${langKey(ref)}`);
  }
}

console.log('');

// ── Build correctors ────────────────────────────────────────

const correctors = new Map<number, Corrector>();
for (const track of textTracks) {
  const ref = trackAlignmentRef.get(track.id);
  const result = ref ? alignmentResults.get(ref.id) : undefined;
  if (result) {
    correctors.set(track.id, buildCorrector(
      result.ratio, result.segments, result.isUniform, result.uniformOffset,
    ));
  }
}

// ── Output ──────────────────────────────────────────────────

if (outputType === 'svg') {
  // ── SVG output ──
  const primaryRefId = uniqueRefIds[0];
  const primaryResult = alignmentResults.get(primaryRefId);

  if (primaryResult) {
    const { generateSvg } = await import('./visualize.js');

    console.log('  Generating SVG...');
    const vizStart = opts.svgStart ?? 0;
    const vizEnd = opts.svgEnd ?? input.duration;

    const svg = generateSvg(
      displayWaveform, primaryResult.vizCues, speechRegions, speakerChanges,
      { pixelsPerSecond: opts.svgScale, startTime: vizStart, endTime: vizEnd },
      speakerSegments,
      primaryResult.scored,
    );

    writeFileSync(outputPath, svg);

    const sizeMB = (Buffer.byteLength(svg) / 1024 / 1024).toFixed(1);
    console.log(`  SVG: ${outputPath}`);
    console.log(`  SVG size: ${sizeMB}MB, scale: ${opts.svgScale}px/sec`);
    console.log(`  Range: ${fmtRange(vizStart, vizEnd)}\n`);
  }

} else if (outputType === 'srt') {
  // ── SRT output ──
  const srtPaths = expandSrtOutputPaths(outputPath, textTracks);

  console.log('  Writing SRT files...');
  for (const track of textTracks) {
    const srtOutPath = srtPaths.get(track.id)!;
    const srtPath = getSrtPath(track);
    let content = readFileSync(srtPath, 'utf-8');

    const corrector = correctors.get(track.id);
    if (corrector) {
      content = adjustContent(content, '.srt', corrector);
    }
    content = fixOverlaps(content, '.srt');

    writeFileSync(srtOutPath, content);
    console.log(`    ${basename(srtOutPath)}`);
  }
  console.log('');

} else {
  // ── Container output (MKV / MKA / MKS) ──
  const tempDir = join(tmpdir(), `ak-sub-sync-mux-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  console.log('  Preparing adjusted subtitles...');
  const muxSubs: MuxSubtitle[] = [];

  for (const track of input.subtitles) {
    const corrector = correctors.get(track.id) ?? null;
    const adjustedPath = prepareAdjustedSubtitle(track, corrector, tempDir);
    const adjusted = corrector ? '✓ adjusted' : 'as-is';
    console.log(`    [${track.id}] ${trackLabel(track)}${trackFlags(track)} — ${adjusted}`);

    muxSubs.push({
      path: adjustedPath,
      language: track.language,
      languageIetf: track.languageIetf,
      trackName: track.trackName,
      forced: track.forced,
      hearingImpaired: track.hearingImpaired,
      defaultTrack: track.defaultTrack,
    });
  }

  const includeVideo = outputType === 'mkv' && !!input.video;
  const includeAudio = outputType !== 'mks';
  const audioSources = includeAudio
    ? [...new Set(input.audioTracks.map(a => a.sourcePath))]
    : [];

  // Mux to temp path if output would overwrite an input file
  const conflictsInput = inputPaths.includes(outputPath);
  const muxPath = conflictsInput
    ? join(tempDir, basename(outputPath))
    : outputPath;

  console.log(`  Muxing → ${basename(outputPath)}...`);
  muxToContainer({
    outputPath: muxPath,
    videoSource: includeVideo ? input.video!.sourcePath : undefined,
    audioSources,
    subtitles: muxSubs,
  });

  if (conflictsInput) {
    const unsyncedDir = join(dirname(outputPath), 'unsynced');
    mkdirSync(unsyncedDir, { recursive: true });
    const backupPath = join(unsyncedDir, basename(outputPath));
    if (existsSync(backupPath)) unlinkSync(backupPath);
    renameSync(outputPath, backupPath);
    renameSync(muxPath, outputPath);
    console.log(`    Backup: ${backupPath}`);
  }

  rmSync(tempDir, { recursive: true, force: true });
  console.log(`  Output: ${outputPath}\n`);
}

// ── Cleanup ──

try { unlinkSync(pcmPath); } catch { /* ignore */ }
for (const f of tempFiles) {
  try { unlinkSync(f); } catch { /* ignore */ }
}

// ── Summary ──

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`  ✓ Done in ${elapsed}s`);

// ── Helpers ──────────────────────────────────────────────────

function trackLabel(track: SubtitleTrack): string {
  return track.trackName ?? (track.languageIetf ?? track.language);
}

function trackFlags(track: SubtitleTrack): string {
  const flags: string[] = [];
  if (track.hearingImpaired) flags.push('SDH');
  if (track.forced) flags.push('forced');
  return flags.length > 0 ? ` (${flags.join(', ')})` : '';
}

function langKey(track: SubtitleTrack): string {
  return track.languageIetf ?? track.language;
}

function groupByLanguage(tracks: SubtitleTrack[]): Map<string, SubtitleTrack[]> {
  const groups = new Map<string, SubtitleTrack[]>();
  for (const track of tracks) {
    const key = langKey(track);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(track);
  }
  return groups;
}

function selectAlignmentRef(
  track: SubtitleTrack,
  allTextTracks: SubtitleTrack[],
  languageGroups: Map<string, SubtitleTrack[]>,
  audioLang: string,
): SubtitleTrack {
  const key = langKey(track);
  const sameLang = languageGroups.get(key) ?? [];

  if (!track.forced && !track.hearingImpaired) return track;

  if (track.hearingImpaired && !track.forced) {
    return sameLang.find(t => !t.hearingImpaired && !t.forced) ?? track;
  }

  const sameLangRegular = sameLang.find(t => !t.hearingImpaired && !t.forced);
  if (sameLangRegular) return sameLangRegular;

  const sameLangSDH = sameLang.find(t => t.hearingImpaired && !t.forced);
  if (sameLangSDH) return sameLangSDH;

  const audioLangTracks = allTextTracks.filter(t => t.language === audioLang);
  const audioRegular = audioLangTracks.find(t => !t.hearingImpaired && !t.forced);
  if (audioRegular) return audioRegular;

  const audioSDH = audioLangTracks.find(t => t.hearingImpaired && !t.forced);
  if (audioSDH) return audioSDH;

  const anyRegular = allTextTracks.find(t => !t.hearingImpaired && !t.forced);
  if (anyRegular) return anyRegular;

  const anySDH = allTextTracks.find(t => t.hearingImpaired && !t.forced);
  if (anySDH) return anySDH;

  return track;
}

function printSearchResult(search: ReturnType<typeof searchBestAlignment>) {
  const bestLabel = describeRatio(search.bestRatio);
  const offsetSign = search.bestOffset >= 0 ? '+' : '';
  console.log(`    ${search.totalIterations.toLocaleString()} combinations in ${search.elapsedMs.toFixed(0)}ms`);
  console.log(`    Best ratio:  ${bestLabel} (${search.bestRatio.toFixed(6)})`);
  console.log(`    Best offset: ${offsetSign}${(search.bestOffset * 1000).toFixed(1)}ms`);
  console.log(`    Best score:  ${search.bestScore.toFixed(2)}`);

  console.log('    Top 5 ratios:');
  for (const r of search.ratioResults.slice(0, 5)) {
    const sign = r.bestOffset >= 0 ? '+' : '';
    const marker = r.ratio === search.bestRatio ? ' ← winner' : '';
    console.log(
      `      ${r.label.padEnd(14)} ` +
      `score=${r.bestScore.toFixed(2).padStart(8)} ` +
      `offset=${sign}${(r.bestOffset * 1000).toFixed(1)}ms` +
      `${marker}`,
    );
  }
  console.log('');
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

function fmtRange(start: number, end: number): string {
  return `${fmtTime(start)} → ${fmtTime(end)}`;
}
