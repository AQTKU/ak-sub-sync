# ak-sub-sync

Automatic subtitle synchronization, designed to fix common problems with broadcast subtitles. Finds and corrects wrong offsets and most bad framerate conversions with a high degree of accuracy.

Uses [pyannote segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) for speaker-aware voice activity detection via ONNX.

## How it works

1. Extracts audio and subtitle tracks from an MKV (or from separate provided files)
2. Detects speech regions and speaker turns using pyannote's segmentation model
3. Segments the file by areas of silence in the audio
4. Evaluates the fit of subtitles at thousands of frame rate ratios and offsets, scoring alignment based on cue starts weighted by a series of factors (start of a sentence, different speaker, etc.)
5. Remuxes the MKV with corrected subtitle timestamps, or outputds a standalone SRT

The scoring function uses an asymmetric proximity window, trying to match most aggressively to perfect cue starts that lead speech by about 50 ms. Earlier cues are found more acceptable than late cues.

The ratio search covers all common frame rate conversions (23.976, 23.98, 24, 25, 29.97, 30 and their cross-products), and the offset search runs at frame-accurate resolution across a ±5 second window.

## Getting started

Add these dependencies to your PATH:

- **[ffmpeg](https://ffmpeg.org/) / ffprobe** - audio/subtitle extraction and stream probing
- **[mkvtoolnix](https://mkvtoolnix.download/)** (mkvmerge, mkvextract) - MKV remuxing with corrected subtitles

Install one of the following:

- **[Bun](https://bun.com/)** - recommended for its native TypeScript support, and it's a tad faster at all the math this script does
- **[Node.js](https://nodejs.org/)**

And run the following on Bun:

```bash
bun install
bun src/cli.ts "path/to/file.mkv"
```

Or the following on Node:

```bash
npm install
npx tsx src/cli.ts "path/to/file.mkv"
```

On first run the pyannote ONNX model (~5MB) is auto-downloaded to `models/`.

Run the command without any arguments for details on input and output files. Right now there aren't many tunables, I might add some in the future, especially around how it generates segments.

## Subtitle track selection

When multiple subtitle tracks are present, ak-sub-sync picks the best candidate automatically:

1. Same language as audio, not SDH, not forced
2. Same language as audio, not forced
3. Any language, not SDH, not forced
4. Any language, not forced
5. Last resort fallback

All text-based subtitle tracks (SRT, ASS/SSA, WebVTT) in the files are corrected during remux. Bitmap formats (PGS, VobSub) are passed through unchanged.

## Credits

The algorithm was designed by [me](https://github.com/aqtku) but the plumbing was all built by [Claude](https://claude.ai).
