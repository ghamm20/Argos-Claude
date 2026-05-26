// v1 chunker. Token approximation: chars/4.
// Greedy fixed-window with paragraph/sentence-aware boundary snapping and
// configurable overlap. Returns char offsets so retrieval can cite back to
// the original document.
//
// v2: replace with a tokenizer-true splitter (tiktoken or model-specific BPE).

export interface RawChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOpts {
  targetTokens?: number;
  overlapTokens?: number;
}

// Phase 3-B (2026-05-25): bumped from 500 → 512 to align with the
// directive's "512 tokens × 10% overlap" spec. The 12-token difference
// is well within the snap-to-boundary tolerance (±250 chars), so this
// is effectively a documentation change. Overlap stays at 10% (~52
// tokens, rounded to 50 for back-compat with already-ingested chunks).
const DEFAULT_TARGET_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 51;

export function chunkText(text: string, opts: ChunkOpts = {}): RawChunk[] {
  const targetChars = (opts.targetTokens ?? DEFAULT_TARGET_TOKENS) * 4;
  const overlapChars = (opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS) * 4;
  const len = text.length;

  if (len === 0) return [];
  if (len <= targetChars) {
    return [{ text: text.trim(), charStart: 0, charEnd: len }];
  }

  const chunks: RawChunk[] = [];
  let start = 0;

  while (start < len) {
    let end = Math.min(start + targetChars, len);

    if (end < len) {
      end = snapToBoundary(text, end);
    }

    if (end <= start) {
      end = Math.min(start + targetChars, len);
    }

    const slice = text.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({ text: slice, charStart: start, charEnd: end });
    }

    if (end >= len) break;
    const nextStart = end - overlapChars;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

function snapToBoundary(text: string, idx: number): number {
  const window = 250;
  const lo = Math.max(0, idx - window);
  const hi = Math.min(text.length, idx + window);
  const slice = text.slice(lo, hi);

  // Prefer paragraph break (\n\n) closest to idx, but not past it by much.
  const paraBreaks: number[] = [];
  let p = slice.indexOf("\n\n");
  while (p !== -1) {
    paraBreaks.push(lo + p + 2);
    p = slice.indexOf("\n\n", p + 1);
  }
  if (paraBreaks.length > 0) {
    const best = paraBreaks.reduce((a, b) =>
      Math.abs(b - idx) < Math.abs(a - idx) ? b : a
    );
    return best;
  }

  // Else sentence terminator near idx.
  const sentRe = /[.!?]\s/g;
  let s: RegExpExecArray | null;
  let bestSent = -1;
  let bestDist = Infinity;
  while ((s = sentRe.exec(slice)) !== null) {
    const absPos = lo + s.index + s[0].length;
    const dist = Math.abs(absPos - idx);
    if (dist < bestDist) {
      bestSent = absPos;
      bestDist = dist;
    }
  }
  if (bestSent !== -1) return bestSent;

  return idx;
}
