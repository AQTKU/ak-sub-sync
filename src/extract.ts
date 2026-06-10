import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FileInfo } from './types.js';

interface FFStream {
  index: number;
  codec_type: string;
  codec_name: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: { language?: string; title?: string };
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

export function extractInfo(inputPath: string): FileInfo {
  const probe = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', inputPath,
  ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

  const data = JSON.parse(probe);
  const streams: FFStream[] = data.streams;
  const duration = parseFloat(data.format?.duration ?? '0');

  const videoStream = streams.find(s => s.codec_type === 'video');
  const fps = parseFrameRate(videoStream?.r_frame_rate ?? videoStream?.avg_frame_rate);

  const audioStream = streams.find(s => s.codec_type === 'audio');
  if (!audioStream) throw new Error('No audio stream found');

  const audioLang = audioStream.tags?.language ?? 'und';
  const audioTrackIndex = audioStream.index;

  return {
    audioTrackIndex,
    audioLang,
    duration,
    fps,
  };
}

interface ExtractAudioOptions {
  /** Bandpass filter to speech frequencies (300Hz–3kHz). Kills music/ambience. */
  speechFilter?: boolean;
}

export function extractAudio(
  inputPath: string,
  audioTrackIndex: number,
  opts?: ExtractAudioOptions,
): string {
  const tag = opts?.speechFilter ? 'filtered' : 'full';
  const outPath = join(tmpdir(), `ak-sync-${tag}-${Date.now()}.pcm`);

  const af = opts?.speechFilter
    ? ['-af', 'highpass=f=300,lowpass=f=3000']
    : [];

  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-map', `0:${audioTrackIndex}`,
    ...af,
    '-ac', '1', '-ar', '16000',
    '-f', 's16le', '-acodec', 'pcm_s16le',
    outPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return outPath;
}

export function extractSubtitle(inputPath: string, subRelativeIndex: number): string {
  const outPath = join(tmpdir(), `ak-sync-subs-${Date.now()}.srt`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-map', `0:s:${subRelativeIndex}`,
    '-f', 'srt', outPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return outPath;
}

export function convertToSrt(inputPath: string): string {
  const outPath = join(tmpdir(), `ak-sync-conv-${Date.now()}.srt`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-f', 'srt', outPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return outPath;
}
