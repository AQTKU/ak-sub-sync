import { InferenceSession, Tensor } from 'onnxruntime-node';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SpeechRegion, AudioEdge, SpeakerSegment } from './types.js';

const SAMPLE_RATE = 16000;
const CHUNK_DURATION = 10;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_DURATION;
const NUM_CLASSES = 7;

const OVERLAP_SAMPLES = SAMPLE_RATE * 5;
const STRIDE_SAMPLES = CHUNK_SAMPLES - OVERLAP_SAMPLES;

// Minimum run length: any non-silence speaker run shorter than this
// is absorbed into the preceding run.  Real speaker turns last seconds;
// sub-100ms blips are always model chatter and create false match
// candidates when aligning run starts to subtitle cues.
const MIN_RUN_SEC = 0.1; // 100ms

const MODEL_URL = 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model.onnx';

// ── Model management ─────────────────────────────────────────

function getModelDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
}

function getModelPath(): string {
  return join(getModelDir(), 'pyannote-segmentation-3.0.onnx');
}

async function ensureModel(): Promise<string> {
  const modelPath = getModelPath();
  if (existsSync(modelPath)) return modelPath;

  console.log('  Downloading pyannote segmentation-3.0 ONNX model...');
  mkdirSync(getModelDir(), { recursive: true });

  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `Failed to download pyannote model (${response.status}).\n` +
      `Manual download:\n  ${MODEL_URL}\n` +
      `Place at:\n  ${modelPath}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1_000_000) throw new Error('Downloaded file too small.');

  writeFileSync(modelPath, buffer);
  console.log(`  Model saved (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  return modelPath;
}

// ── Softmax ──────────────────────────────────────────────────

function softmaxRow(logits: Float32Array, offset: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (logits[offset + i] > max) max = logits[offset + i];
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(logits[offset + i] - max);
    sum += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}

// ── Run a single chunk ───────────────────────────────────────

async function runChunk(
  session: InferenceSession,
  chunk: Float32Array,
): Promise<{ logits: Float32Array; framesPerChunk: number }> {
  const input = new Tensor('float32', chunk, [1, 1, CHUNK_SAMPLES]);
  const results = await session.run({ input_values: input });

  const logitsTensor = results.logits;
  const dims = logitsTensor.dims as readonly number[];
  return {
    logits: logitsTensor.data as Float32Array,
    framesPerChunk: dims[1],
  };
}

// ── Cross-chunk label stitching (powerset-aware) ─────────────

/**
 * Pyannote segmentation-3.0 uses a POWERSET encoding over 3 local speakers:
 *
 *   Class 0: silence
 *   Class 1: speaker₀        Class 4: speaker₀ + speaker₁
 *   Class 2: speaker₁        Class 5: speaker₀ + speaker₂
 *   Class 3: speaker₂        Class 6: speaker₁ + speaker₂
 *
 * The labels are LOCAL per chunk — speaker₀ in chunk A may be speaker₂
 * in chunk B.  The stitching task is finding the 3-element permutation
 * of (speaker₀, speaker₁, speaker₂) that aligns the new chunk to the
 * running global labeling.  Once the speaker permutation is known, the
 * full 7-class mapping falls out deterministically.
 *
 * We match using single-speaker frames in the overlap region (classes 1–3),
 * which are the most reliable signal.  If the overlap is pure silence or
 * pure overlap-speech, we fall back to the identity permutation (assume
 * the model didn't reshuffle).
 */

/** Which underlying speakers are active in each powerset class. */
const SPEAKERS_IN_CLASS: readonly number[][] = [
  [],     // 0: silence
  [0],    // 1: speaker₀
  [1],    // 2: speaker₁
  [2],    // 3: speaker₂
  [0, 1], // 4: speaker₀ + speaker₁
  [0, 2], // 5: speaker₀ + speaker₂
  [1, 2], // 6: speaker₁ + speaker₂
];

/** Reverse: sorted speaker set → powerset class. */
function speakersToClass(speakers: number[]): number {
  if (speakers.length === 0) return 0;
  if (speakers.length === 1) return speakers[0] + 1;
  const [a, b] = speakers;
  if (a === 0 && b === 1) return 4;
  if (a === 0 && b === 2) return 5;
  if (a === 1 && b === 2) return 6;
  return 0;
}

/**
 * Build the full class 0–6 → class 0–6 mapping from a speaker permutation.
 * speakerPerm maps local speaker index (0–2) → global speaker index (0–2).
 */
function buildClassMap(speakerPerm: Map<number, number>): Map<number, number> {
  const classMap = new Map<number, number>();
  classMap.set(0, 0); // silence → silence
  for (let cl = 1; cl <= 6; cl++) {
    const localSpeakers = SPEAKERS_IN_CLASS[cl];
    const globalSpeakers = localSpeakers
      .map(s => speakerPerm.get(s) ?? s)
      .sort((a, b) => a - b);
    classMap.set(cl, speakersToClass(globalSpeakers));
  }
  return classMap;
}

/**
 * Find the speaker permutation that aligns currOverlap to prevOverlap.
 * Only considers single-speaker frames (classes 1–3) for matching.
 * Returns a full class map (0–6 → 0–6).
 */
function stitchChunk(
  prevOverlapLabels: Int8Array,  // global classes (already stitched)
  currOverlapLabels: Int8Array,  // local classes (raw from model)
): Map<number, number> {
  // Count co-occurrences of (globalSpeaker, localSpeaker) on single-speaker frames
  const agreement = new Map<string, number>();
  const len = Math.min(prevOverlapLabels.length, currOverlapLabels.length);

  for (let f = 0; f < len; f++) {
    const prevCl = prevOverlapLabels[f];
    const currCl = currOverlapLabels[f];
    // Both must be single-speaker classes (1, 2, or 3)
    if (prevCl >= 1 && prevCl <= 3 && currCl >= 1 && currCl <= 3) {
      const globalSpk = prevCl - 1;
      const localSpk = currCl - 1;
      const key = `${globalSpk},${localSpk}`;
      agreement.set(key, (agreement.get(key) ?? 0) + 1);
    }
  }

  // Greedy-match speakers by agreement count
  const pairs = [...agreement.entries()]
    .map(([k, count]) => {
      const [g, l] = k.split(',').map(Number);
      return { global: g, local: l, count };
    })
    .sort((a, b) => b.count - a.count);

  const speakerPerm = new Map<number, number>();
  const usedGlobal = new Set<number>();
  const usedLocal = new Set<number>();

  for (const { global: g, local: l } of pairs) {
    if (usedGlobal.has(g) || usedLocal.has(l)) continue;
    speakerPerm.set(l, g);
    usedGlobal.add(g);
    usedLocal.add(l);
  }

  // Unmatched speakers get the remaining global slots
  const unusedGlobal = [0, 1, 2].filter(g => !usedGlobal.has(g));
  const unmatchedLocal = [0, 1, 2].filter(l => !usedLocal.has(l));
  for (let i = 0; i < unmatchedLocal.length; i++) {
    speakerPerm.set(unmatchedLocal[i], unusedGlobal[i]);
  }

  return buildClassMap(speakerPerm);
}

/** Apply a class mapping. */
function remapClass(localClass: number, mapping: Map<number, number>): number {
  return mapping.get(localClass) ?? localClass;
}

// ── Main inference ───────────────────────────────────────────

export interface PyannoteResult {
  speechRegions: SpeechRegion[];
  speakerChanges: AudioEdge[];
  speakerSegments: SpeakerSegment[];
}

export async function runPyannoteVad(pcmPath: string): Promise<PyannoteResult> {
  const modelPath = await ensureModel();
  const session = await InferenceSession.create(modelPath);

  // Read PCM
  const pcmBuffer = readFileSync(pcmPath);
  const numSamples = pcmBuffer.length / 2;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768;
  }

  const totalDuration = numSamples / SAMPLE_RATE;

  // Probe model to get actual frame count
  const probeChunk = new Float32Array(CHUNK_SAMPLES);
  probeChunk.set(samples.slice(0, Math.min(CHUNK_SAMPLES, numSamples)));
  const probeResult = await runChunk(session, probeChunk);
  const framesPerChunk = probeResult.framesPerChunk;
  const frameDuration = CHUNK_DURATION / framesPerChunk;

  console.log(`    Model output: ${framesPerChunk} frames/chunk (${(frameDuration * 1000).toFixed(2)}ms/frame)`);

  const totalFrames = Math.ceil(totalDuration / frameDuration);
  const minRunFrames = Math.ceil(MIN_RUN_SEC / frameDuration);
  console.log(`    Min run length: ${MIN_RUN_SEC * 1000}ms (${minRunFrames} frames)`);

  // Per-frame accumulators
  const speechProbSum = new Float32Array(totalFrames);
  const frameWeight = new Float32Array(totalFrames);
  const frameSpeaker = new Int8Array(totalFrames);
  const frameSpeakerConf = new Float32Array(totalFrames);
  const frameOwnerDist = new Float32Array(totalFrames).fill(Infinity);

  const allSpeakerChanges: AudioEdge[] = [];

  // Cross-chunk label stitching state
  let prevOverlapArgmax: Int8Array | null = null;
  const overlapFrames = Math.round(framesPerChunk / 2); // half chunk = overlap region

  // Process chunks
  const numChunks = Math.max(1, Math.ceil((numSamples - OVERLAP_SAMPLES) / STRIDE_SAMPLES));
  const progressInterval = Math.max(1, Math.floor(numChunks / 20));

  for (let c = 0; c < numChunks; c++) {
    if (c % progressInterval === 0) {
      process.stderr.write(`\r  Pyannote progress: ${Math.round((c / numChunks) * 100)}%`);
    }

    const chunkStartSample = c * STRIDE_SAMPLES;
    const actualEnd = Math.min(chunkStartSample + CHUNK_SAMPLES, numSamples);
    const actualSamples = actualEnd - chunkStartSample;

    const chunk = new Float32Array(CHUNK_SAMPLES);
    chunk.set(samples.slice(chunkStartSample, actualEnd));

    const { logits } = c === 0 ? probeResult : await runChunk(session, chunk);

    const validFrames = Math.min(
      framesPerChunk,
      Math.ceil((actualSamples / CHUNK_SAMPLES) * framesPerChunk),
    );

    // Step 1: Softmax → argmax per frame (+ accumulate VAD probability)
    const localArgmax = new Int8Array(validFrames);
    const localConf = new Float32Array(validFrames);
    const rawProbs = new Float32Array(validFrames * NUM_CLASSES);

    for (let f = 0; f < validFrames; f++) {
      const probs = softmaxRow(logits, f * NUM_CLASSES, NUM_CLASSES);
      rawProbs.set(probs, f * NUM_CLASSES);

      let bestClass = 0;
      let bestProb = probs[0];
      for (let cl = 1; cl < NUM_CLASSES; cl++) {
        if (probs[cl] > bestProb) {
          bestProb = probs[cl];
          bestClass = cl;
        }
      }
      localArgmax[f] = bestClass;
      localConf[f] = bestProb;
    }

    // Step 2: Stitch labels — find the speaker permutation that aligns
    //         this chunk's local labels to the global labeling
    let chunkClassMap: Map<number, number>;

    if (c > 0 && prevOverlapArgmax) {
      // Match speakers in the overlap, derive full class mapping
      const currOverlap = localArgmax.slice(0, Math.min(overlapFrames, validFrames));
      chunkClassMap = stitchChunk(prevOverlapArgmax, currOverlap);
    } else {
      // First chunk: identity mapping (local classes = global classes)
      chunkClassMap = buildClassMap(new Map([[0, 0], [1, 1], [2, 2]]));
    }

    // Store overlap data for next chunk: last overlapFrames, in GLOBAL labels
    const overlapStart = Math.max(0, validFrames - overlapFrames);
    prevOverlapArgmax = new Int8Array(validFrames - overlapStart);
    for (let f = 0; f < prevOverlapArgmax.length; f++) {
      prevOverlapArgmax[f] = remapClass(localArgmax[overlapStart + f], chunkClassMap);
    }

    // Step 3: Integrate into global arrays using REMAPPED labels
    const chunkStartTime = chunkStartSample / SAMPLE_RATE;
    const chunkCenterTime = chunkStartTime + CHUNK_DURATION / 2;
    let prevSpeakerClass = -1;

    for (let f = 0; f < validFrames; f++) {
      const frameTime = chunkStartTime + f * frameDuration;
      const gf = Math.round(frameTime / frameDuration);
      if (gf < 0 || gf >= totalFrames) continue;

      // VAD: use RAW probabilities (unchanged)
      speechProbSum[gf] += (1 - rawProbs[f * NUM_CLASSES]);
      frameWeight[gf] += 1;

      // Speaker: use stitched global class
      const globalClass = remapClass(localArgmax[f], chunkClassMap);
      const conf = localConf[f];

      // Center-crop ownership
      const distToCenter = Math.abs(frameTime - chunkCenterTime);
      if (distToCenter < frameOwnerDist[gf]) {
        frameSpeaker[gf] = globalClass;
        frameSpeakerConf[gf] = conf;
        frameOwnerDist[gf] = distToCenter;
      }

      // Speaker changes (using global labels, so cross-chunk changes are real)
      if (globalClass > 0 && prevSpeakerClass > 0 && globalClass !== prevSpeakerClass) {
        allSpeakerChanges.push({
          time: frameTime,
          type: 'onset',
          strength: Math.min(1, conf),
        });
      }
      if (globalClass > 0) prevSpeakerClass = globalClass;
    }
  }

  process.stderr.write(`\r  Pyannote progress: 100%\n`);

  // Average VAD
  const speechProb = new Float32Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    if (frameWeight[f] > 0) speechProb[f] = speechProbSum[f] / frameWeight[f];
  }

  const speechRegions = probsToRegions(speechProb, frameDuration);

  // Absorb short speaker blips into their predecessors
  const blipsFixed = enforceMinRunLength(frameSpeaker, totalFrames, minRunFrames);
  console.log(`    Min-run filter: ${blipsFixed} short runs absorbed (< ${MIN_RUN_SEC * 1000}ms)`);

  const speakerSegments = buildSpeakerSegments(frameSpeaker, totalFrames, frameDuration);
  const speakerChanges = deduplicateChanges(allSpeakerChanges, 0.1);

  // Stats
  const classCounts = new Map<number, number>();
  for (let f = 0; f < totalFrames; f++) {
    classCounts.set(frameSpeaker[f], (classCounts.get(frameSpeaker[f]) ?? 0) + 1);
  }
  const activeClasses = [...classCounts.keys()].filter(c => c > 0).length;
  console.log(`    Stitching: ${activeClasses} active speaker classes across ${numChunks} chunks (classes capped at 1–6)`);
  console.log('    Class distribution:');
  for (const [cl, count] of [...classCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalFrames) * 100).toFixed(1);
    const label = cl === 0 ? 'silence' : `speaker ${cl}`;
    console.log(`      ${label}: ${pct}% (${count} frames)`);
  }

  return { speechRegions, speakerChanges, speakerSegments };
}

// ── Post-processing: minimum run length ──────────────────────

/**
 * Any non-silence speaker run shorter than minFrames is absorbed
 * into the preceding run (whether silence or speech).  This kills
 * model chatter without shifting any real boundaries — a genuine
 * speaker turn lasts seconds, so sub-100ms blips are always noise.
 */
function enforceMinRunLength(labels: Int8Array, totalFrames: number, minFrames: number): number {
  if (totalFrames === 0) return 0;

  // Encode as runs
  interface Run { cls: number; start: number; len: number }
  const runs: Run[] = [];
  let runStart = 0;

  for (let f = 1; f <= totalFrames; f++) {
    if (f === totalFrames || labels[f] !== labels[f - 1]) {
      runs.push({ cls: labels[runStart], start: runStart, len: f - runStart });
      runStart = f;
    }
  }

  // Merge short non-silence runs into their predecessor
  const merged: Run[] = [];
  let fixed = 0;

  for (const run of runs) {
    if (run.cls > 0 && run.len < minFrames && merged.length > 0) {
      // Absorb into previous run
      merged[merged.length - 1].len += run.len;
      fixed++;
    } else {
      merged.push({ ...run });
    }
  }

  // Write back
  for (const run of merged) {
    for (let f = run.start; f < run.start + run.len; f++) {
      labels[f] = run.cls;
    }
  }

  return fixed;
}

// ── Post-processing: speech regions ──────────────────────────

function probsToRegions(probs: Float32Array, frameDur: number): SpeechRegion[] {
  const ONSET = 0.5;
  const OFFSET = 0.35;
  const MIN_SPEECH = Math.ceil(0.25 / frameDur);
  const MIN_SILENCE = Math.ceil(0.15 / frameDur);

  const regions: SpeechRegion[] = [];
  let inSpeech = false;
  let speechStart = 0;
  let silenceCount = 0;

  for (let i = 0; i < probs.length; i++) {
    if (!inSpeech) {
      if (probs[i] >= ONSET) { inSpeech = true; speechStart = i; silenceCount = 0; }
    } else {
      if (probs[i] < OFFSET) {
        silenceCount++;
        if (silenceCount >= MIN_SILENCE) {
          const end = i - silenceCount;
          if (end - speechStart >= MIN_SPEECH) {
            regions.push({ start: speechStart * frameDur, end: end * frameDur });
          }
          inSpeech = false;
        }
      } else { silenceCount = 0; }
    }
  }

  if (inSpeech && probs.length - speechStart >= MIN_SPEECH) {
    regions.push({ start: speechStart * frameDur, end: probs.length * frameDur });
  }
  return regions;
}

// ── Post-processing: speaker segments ────────────────────────

function buildSpeakerSegments(frameSpeaker: Int8Array, totalFrames: number, frameDur: number): SpeakerSegment[] {
  if (totalFrames === 0) return [];

  const segments: SpeakerSegment[] = [];
  let segStart = 0;
  let segClass = frameSpeaker[0];

  for (let f = 1; f < totalFrames; f++) {
    if (frameSpeaker[f] !== segClass) {
      if (segClass > 0) {
        segments.push({ start: segStart * frameDur, end: f * frameDur, speaker: segClass });
      }
      segStart = f;
      segClass = frameSpeaker[f];
    }
  }

  if (segClass > 0) {
    segments.push({ start: segStart * frameDur, end: totalFrames * frameDur, speaker: segClass });
  }

  return segments;
}

function deduplicateChanges(changes: AudioEdge[], minGap: number): AudioEdge[] {
  if (changes.length === 0) return [];
  const sorted = [...changes].sort((a, b) => a.time - b.time);
  const result: AudioEdge[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - result[result.length - 1].time >= minGap) {
      result.push(sorted[i]);
    }
  }
  return result;
}