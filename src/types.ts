export interface SubtitleCue {
  index: number;
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface SpeechRegion {
  start: number; // seconds
  end: number;   // seconds
}

export interface AudioEdge {
  time: number;       // seconds
  type: 'onset' | 'offset';
  strength: number;   // 0–1
}

/** A segment where a specific speaker is dominant. */
export interface SpeakerSegment {
  start: number;   // seconds
  end: number;     // seconds
  speaker: number; // 1-6 (pyannote powerset class), 0 = silence
}

export interface WaveformData {
  rms: Float32Array;
  windowSize: number; // window size in seconds
  duration: number;   // total duration in seconds
}

export interface FileInfo {
  audioTrackIndex: number;
  audioLang: string;
  duration: number;
  fps: number;
}

// ── Multi-file input types ──────────────────────────────────

export interface VideoSource {
  sourcePath: string;
  streamIndex: number;
  fps: number;
}

export interface AudioSource {
  sourcePath: string;
  streamIndex: number;
  language: string;
  channels: number;
  defaultTrack: boolean;
}

export interface SubtitleTrack {
  id: number;
  sourcePath: string;
  sourceType: 'standalone' | 'container';
  relativeSubIndex: number;
  containerTrackId: number;
  codec: string;
  codecId: string;
  language: string;
  languageIetf?: string;
  trackName?: string;
  forced: boolean;
  hearingImpaired: boolean;
  defaultTrack: boolean;
  isText: boolean;
}

export interface CollectedInput {
  video?: VideoSource;
  audio: AudioSource;
  audioTracks: AudioSource[];
  subtitles: SubtitleTrack[];
  duration: number;
  fps: number;
}

export interface Chapter {
  start: number;
  end: number;
  name: string;
}

export type OutputType = 'svg' | 'mkv' | 'mka' | 'mks' | 'srt';
