import { readFileSync } from 'fs';
import type { SubtitleCue } from './types.js';

function parseTimestamp(ts: string): number {
  const match = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(ms.padEnd(3, '0')) / 1000
  );
}

export function parseSrt(path: string): SubtitleCue[] {
  const content = readFileSync(path, 'utf-8');
  const cues: SubtitleCue[] = [];

  // Normalize line endings and split on blank lines
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timecode line (contains -->)
    const tcLineIndex = lines.findIndex(l => l.includes('-->'));
    if (tcLineIndex === -1) continue;

    const tcLine = lines[tcLineIndex];
    const [startStr, endStr] = tcLine.split('-->');
    if (!startStr || !endStr) continue;

    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);

    // Strip HTML tags, join remaining lines
    const text = lines
      .slice(tcLineIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    const indexStr = lines.slice(0, tcLineIndex).join('').trim();
    const index = parseInt(indexStr) || cues.length + 1;

    if (end > start) {
      cues.push({ index, start, end, text });
    }
  }

  return cues;
}

/**
 * Clean subtitle cues for sync scoring:
 *  - Strip ASS/SSA override tags: {\an8}, {\pos(320,50)}, etc.
 *  - Strip residual HTML tags
 *  - Strip SDH in square brackets: [laughing], [door slams]
 *  - Strip SDH in parentheses: (sighs), (speaking French)
 *  - Collapse whitespace, trim
 *  - Remove cues that are now empty
 *
 * Returns a new array — original cues are not mutated.
 */
export function cleanCues(cues: SubtitleCue[]): SubtitleCue[] {
  const cleaned: SubtitleCue[] = [];

  for (const cue of cues) {
    let text = cue.text;

    // ASS/SSA override tags: {\an8}, {\pos(x,y)}, {\fnArial\fs20}, etc.
    text = text.replace(/\{\\[^}]*\}/g, '');

    // Residual HTML tags (parseSrt already strips these, but belt-and-suspenders)
    text = text.replace(/<[^>]+>/g, '');

    // SDH: square brackets — [laughing], [door slams], [♪ music ♪]
    text = text.replace(/\[[^\]]*\]/g, '');

    // SDH: parentheses — (sighs), (in Spanish)
    text = text.replace(/\([^)]*\)/g, '');

    // Collapse whitespace (including newlines) and trim
    text = text.replace(/\s+/g, ' ').trim();

    if (text.length === 0) continue;

    cleaned.push({ ...cue, text });
  }

  return cleaned;
}
