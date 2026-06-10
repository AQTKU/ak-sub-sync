import { readFileSync } from 'fs';
import type { WaveformData } from './types.js';

const SAMPLE_RATE = 16000;

/**
 * Compute RMS waveform envelope from 16-bit signed LE mono PCM at 16kHz.
 * @param pcmPath Path to the raw PCM file
 * @param windowMs Window size in milliseconds (default 20ms = 50 windows/sec)
 */
export function computeWaveform(pcmPath: string, windowMs: number = 20): WaveformData {
  const buffer = readFileSync(pcmPath);
  const numSamples = buffer.length / 2;
  const duration = numSamples / SAMPLE_RATE;
  const windowSize = windowMs / 1000;
  const samplesPerWindow = Math.floor(SAMPLE_RATE * windowSize);
  const numWindows = Math.floor(numSamples / samplesPerWindow);

  const rms = new Float32Array(numWindows);

  for (let w = 0; w < numWindows; w++) {
    let sumSq = 0;
    const offset = w * samplesPerWindow;
    for (let i = 0; i < samplesPerWindow; i++) {
      const sample = buffer.readInt16LE((offset + i) * 2) / 32768;
      sumSq += sample * sample;
    }
    rms[w] = Math.sqrt(sumSq / samplesPerWindow);
  }

  return { rms, windowSize, duration };
}
