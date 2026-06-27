/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface Sentence {
  /** TTS-ready, cleaned plain text. */
  text: string;
  /** [startOffset, endOffset] in the cumulative RAW buffer. */
  range: [number, number];
}

interface Thresholds {
  min: number;
  max: number;
}

const CJK_BOUNDARY_CHARS = new Set<string>(['。', '！', '？', '；', '…']);
const LATIN_BOUNDARY_CHARS = new Set<string>(['.', '!', '?', ';']);
const ABBREVIATIONS = ['Mr.', 'Dr.', 'Mrs.', 'Ms.', 'e.g.', 'i.e.', 'etc.', 'vs.', 'Inc.'];
const URL_PROTOCOL = /^https?:\/\//i;

const isCjkChar = (ch: string): boolean => {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  // Cover the common CJK Unified Ideographs, Hiragana, Katakana, Hangul, plus fullwidth punctuation.
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK symbols and punctuation
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xff00 && code <= 0xffef) // Halfwidth/fullwidth forms
  );
};

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

/**
 * Streaming sentence splitter for TTS pipelines. Accepts an LLM token stream
 * and yields TTS-ready sentences as boundaries are detected.
 */
export class SentenceSplitter {
  private rawBuffer = '';
  private rawCursor = 0;
  private inCodeFence = false;
  private broken = false;

  // Current sentence state.
  private pendingCleaned = '';
  private pendingRawStart = 0;

  // Current line state — cleaned chars not yet committed to the sentence buffer.
  private lineCleaned = '';
  private lineRawStart = 0;
  private lineDrop = false;
  private atLineStart = true;

  push(token: string): Sentence[] {
    if (this.broken) return [];
    try {
      this.rawBuffer += token;
      return this.drain(false);
    } catch {
      this.broken = true;
      return [];
    }
  }

  end(): Sentence[] {
    if (this.broken) return [];
    try {
      const sentences = this.drain(true);
      // Flush any non-empty residual sentence regardless of min threshold.
      // First, finalize the current line if there is any partial line.
      if (this.lineCleaned.length > 0 && !this.lineDrop) {
        this.pendingCleaned += this.lineCleaned;
      }
      this.lineCleaned = '';
      const trimmed = this.pendingCleaned.trim();
      if (trimmed.length > 0) {
        const finalRange: [number, number] = [this.pendingRawStart, this.rawBuffer.length];
        this.pendingCleaned = '';
        this.pendingRawStart = this.rawBuffer.length;
        return [...sentences, { text: trimmed, range: finalRange }];
      }
      return sentences;
    } catch {
      this.broken = true;
      return [];
    }
  }

  private drain(isEnd: boolean): Sentence[] {
    const out: Sentence[] = [];
    while (this.rawCursor < this.rawBuffer.length) {
      const consumed = this.step(isEnd, out);
      if (consumed === 0) break; // Need more input to safely advance.
    }
    return out;
  }

  /**
   * Process one logical chunk starting at rawCursor. Returns the number of raw
   * chars consumed. Returns 0 when the splitter must wait for more input (e.g.
   * mid-URL, mid-code-fence-marker).
   */
  private step(isEnd: boolean, out: Sentence[]): number {
    const start = this.rawCursor;
    const ch = this.rawBuffer[start];

    // 1) Code fence handling — match a literal "```" possibly preceded by line start.
    if (this.rawBuffer.startsWith('```', start)) {
      this.inCodeFence = !this.inCodeFence;
      this.rawCursor += 3;
      return 3;
    }
    if (this.inCodeFence) {
      // Could be a partial closing fence — wait for more if next chars MIGHT extend to "```".
      if (!isEnd && this.couldExtendToFence(start)) return 0;
      this.rawCursor += 1;
      return 1;
    }
    // Outside fence: if the buffer might still grow into a fence marker, wait.
    if (!isEnd && this.couldExtendToFence(start) && this.rawBuffer.length - start < 3) {
      return 0;
    }

    // 2) Newline handling.
    if (ch === '\n') {
      this.finalizeLine(out);
      // \n\n is a CJK paragraph boundary — handled inside maybeEmit via consecutive newlines.
      // We model paragraph break by appending a single '\n' to pendingCleaned only when
      // the line wasn't dropped. The CJK boundary fires on second consecutive newline.
      // We don't append the \n itself to the cleaned sentence buffer; instead we look for
      // \n\n in the RAW stream as a boundary signal.
      const next = this.rawBuffer[start + 1];
      if (next === '\n') {
        // Boundary: flush current pending sentence if past min.
        this.tryEmitBoundary(out, start + 2, true);
        this.rawCursor = start + 2;
        this.startLine(this.rawCursor);
        return 2;
      }
      this.rawCursor = start + 1;
      this.startLine(this.rawCursor);
      return 1;
    }

    // 3) At line start, sniff for heading / list markers.
    if (this.atLineStart) {
      // Drop leading whitespace at line start (but keep tracking raw offset).
      if (isWhitespace(ch)) {
        this.rawCursor = start + 1;
        return 1;
      }
      // Heading: # (any number) + space
      const headingMatch = /^(#{1,6})\s+/.exec(this.rawBuffer.slice(start));
      if (headingMatch) {
        this.rawCursor = start + headingMatch[0].length;
        this.atLineStart = false;
        return headingMatch[0].length;
      }
      // Image: ![alt](url) line — drop the whole line.
      if (ch === '!' && this.rawBuffer[start + 1] === '[') {
        this.lineDrop = true;
        this.atLineStart = false;
        this.rawCursor = start + 1;
        return 1;
      }
      // Unordered list: "- " or "* " (but NOT a horizontal rule like "---").
      if ((ch === '-' || ch === '*') && this.rawBuffer[start + 1] === ' ') {
        this.rawCursor = start + 2;
        this.atLineStart = false;
        return 2;
      }
      // Ordered list: "1. " (digits + dot + space).
      const olMatch = /^(\d+)\.\s/.exec(this.rawBuffer.slice(start));
      if (olMatch) {
        this.rawCursor = start + olMatch[0].length;
        this.atLineStart = false;
        return olMatch[0].length;
      }
      this.atLineStart = false;
    }

    // 4) URL replacement — only when we have the full URL terminator.
    if ((ch === 'h' || ch === 'H') && URL_PROTOCOL.test(this.rawBuffer.slice(start, start + 8))) {
      // Find URL end: first whitespace, newline, or end-of-buffer.
      let end = start;
      while (end < this.rawBuffer.length && !isWhitespace(this.rawBuffer[end])) {
        end++;
      }
      if (end === this.rawBuffer.length && !isEnd) {
        // URL might still be growing — wait.
        return 0;
      }
      // Replace the URL with "link" in cleaned text.
      this.appendToLine('link');
      const consumed = end - start;
      this.rawCursor = end;
      return consumed;
    }

    // 5) Pipe '|' detected → this line is a table-row; drop it.
    if (ch === '|') {
      this.lineDrop = true;
      this.lineCleaned = '';
      this.rawCursor = start + 1;
      return 1;
    }

    // 6) Markdown marker chars to silently drop.
    if (ch === '*' || ch === '_' || ch === '`') {
      this.rawCursor = start + 1;
      return 1;
    }

    // 7) Boundary detection. We may need lookahead for Latin "." protections.
    if (this.isBoundary(start, isEnd)) {
      // Commit this boundary char into the cleaned buffer, then attempt to emit.
      this.appendToLine(ch);
      this.rawCursor = start + 1;
      this.tryEmitBoundary(out, this.rawCursor, false);
      return 1;
    }

    // 8) Default: append the char to the line buffer.
    this.appendToLine(ch);
    this.rawCursor = start + 1;
    this.maybeForceSplit(out);
    return 1;
  }

  private couldExtendToFence(start: number): boolean {
    // True if the chars from `start` are a non-empty prefix of "```" and the buffer
    // ends before we can be sure (so we should wait).
    const slice = this.rawBuffer.slice(start, start + 3);
    if (slice.length >= 3) return false;
    return '```'.startsWith(slice) && slice.length > 0 && slice[0] === '`';
  }

  private startLine(rawStart: number): void {
    this.lineCleaned = '';
    this.lineRawStart = rawStart;
    this.lineDrop = false;
    this.atLineStart = true;
  }

  private finalizeLine(out: Sentence[]): void {
    if (!this.lineDrop && this.lineCleaned.length > 0) {
      // Append a separating space if needed so adjacent lines don't smash together.
      if (this.pendingCleaned.length > 0 && !/\s$/.test(this.pendingCleaned)) {
        this.pendingCleaned += ' ';
      }
      this.pendingCleaned += this.lineCleaned;
      this.maybeForceSplit(out);
    }
    this.lineCleaned = '';
  }

  private appendToLine(s: string): void {
    if (this.lineDrop) return;
    if (this.pendingCleaned.length === 0 && this.lineCleaned.length === 0) {
      this.pendingRawStart = this.lineRawStart;
    }
    this.lineCleaned += s;
  }

  private isBoundary(start: number, isEnd: boolean): boolean {
    const ch = this.rawBuffer[start];
    if (CJK_BOUNDARY_CHARS.has(ch)) return true;
    if (!LATIN_BOUNDARY_CHARS.has(ch)) return false;
    // Latin boundary: must be followed by whitespace (or end-of-stream on .end()).
    const next = this.rawBuffer[start + 1];
    if (next === undefined) {
      // Don't decide mid-stream — wait for next char (unless end()).
      if (!isEnd) return false;
    } else if (!isWhitespace(next)) {
      return false;
    }
    // Decimal protection: digit '.' digit
    if (ch === '.') {
      const prev = this.rawBuffer[start - 1];
      const after = this.rawBuffer[start + 1];
      if (prev && /\d/.test(prev) && after && /\d/.test(after)) {
        return false;
      }
      // Abbreviation protection: check if the run leading up to `.` matches a known abbreviation.
      const lookbehind = this.rawBuffer.slice(Math.max(0, start - 5), start + 1);
      for (const abbr of ABBREVIATIONS) {
        if (lookbehind.toLowerCase().endsWith(abbr.toLowerCase())) {
          // Ensure the abbreviation isn't preceded by a letter (avoid matching "MetricInc." mid-word).
          const idx = lookbehind.toLowerCase().lastIndexOf(abbr.toLowerCase());
          const realStart = Math.max(0, start - 5) + idx;
          const before = this.rawBuffer[realStart - 1];
          if (!before || !/[a-z]/i.test(before)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  private currentLanguageThresholds(): Thresholds {
    const combined = this.pendingCleaned + this.lineCleaned;
    if (combined.length === 0) return { min: 40, max: 240 };
    let cjk = 0;
    for (const ch of combined) {
      if (isCjkChar(ch)) cjk++;
    }
    const proportion = cjk / combined.length;
    if (proportion >= 0.4) return { min: 20, max: 80 };
    return { min: 40, max: 240 };
  }

  private tryEmitBoundary(out: Sentence[], rawEnd: number, force: boolean): void {
    // If a boundary fires while line content is still uncommitted, flush the line first.
    if (this.lineCleaned.length > 0 && !this.lineDrop) {
      this.pendingCleaned += this.lineCleaned;
      this.lineCleaned = '';
    } else if (this.lineDrop) {
      this.lineCleaned = '';
    }
    const cleaned = this.pendingCleaned.trim();
    if (cleaned.length === 0) {
      // Nothing to emit — reset the sentence-start anchor to this raw end.
      this.pendingCleaned = '';
      this.pendingRawStart = rawEnd;
      this.lineRawStart = rawEnd;
      return;
    }
    const { min } = this.currentLanguageThresholds();
    if (!force && cleaned.length < min) return;
    out.push({ text: cleaned, range: [this.pendingRawStart, rawEnd] });
    this.pendingCleaned = '';
    this.pendingRawStart = rawEnd;
    // After a mid-line emission, the next sentence anchor should pick up from rawEnd,
    // not from the original line start.
    this.lineRawStart = rawEnd;
  }

  private maybeForceSplit(out: Sentence[]): void {
    const { max } = this.currentLanguageThresholds();
    const combinedLen = this.pendingCleaned.length + this.lineCleaned.length;
    if (combinedLen < max) return;
    // Flush line into pending so we can carve off `max` cleaned chars.
    if (this.lineCleaned.length > 0 && !this.lineDrop) {
      this.pendingCleaned += this.lineCleaned;
      this.lineCleaned = '';
    }
    while (this.pendingCleaned.length >= max) {
      // Force-split the first `max` cleaned chars into a sentence.
      const chunk = this.pendingCleaned.slice(0, max);
      const trimmed = chunk.trim();
      if (trimmed.length === 0) {
        this.pendingCleaned = this.pendingCleaned.slice(max);
        this.pendingRawStart = this.rawCursor;
        continue;
      }
      out.push({ text: trimmed, range: [this.pendingRawStart, this.rawCursor] });
      this.pendingCleaned = this.pendingCleaned.slice(max);
      this.pendingRawStart = this.rawCursor;
    }
  }
}
