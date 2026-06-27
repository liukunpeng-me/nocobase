/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Sentence, SentenceSplitter } from '../sentence-splitter';

const feedAll = (splitter: SentenceSplitter, tokens: string[]): Sentence[] => {
  const out: Sentence[] = [];
  for (const token of tokens) {
    out.push(...splitter.push(token));
  }
  out.push(...splitter.end());
  return out;
};

const feedString = (splitter: SentenceSplitter, raw: string, chunkSize = 5): Sentence[] => {
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += chunkSize) {
    tokens.push(raw.slice(i, i + chunkSize));
  }
  return feedAll(splitter, tokens);
};

describe('SentenceSplitter', () => {
  describe('CJK boundary handling', () => {
    it('splits a CJK paragraph on 。！？', () => {
      const splitter = new SentenceSplitter();
      // Each clause is at least 20 CJK chars to meet the CJK min threshold.
      const raw =
        '今天天气真的非常好阳光明媚适合出门散步。' +
        '但是下午可能会下雨记得带上一把雨伞出门！' +
        '你今天打算去哪里玩呢请告诉我好吗？';
      const sentences = feedString(splitter, raw, 7);

      expect(sentences).toHaveLength(3);
      expect(sentences[0].text).toBe('今天天气真的非常好阳光明媚适合出门散步。');
      expect(sentences[1].text).toBe('但是下午可能会下雨记得带上一把雨伞出门！');
      expect(sentences[2].text).toBe('你今天打算去哪里玩呢请告诉我好吗？');
      // Ranges should be contiguous over the raw buffer.
      expect(sentences[0].range[0]).toBe(0);
      expect(sentences[2].range[1]).toBe(raw.length);
      for (let i = 1; i < sentences.length; i++) {
        expect(sentences[i].range[0]).toBe(sentences[i - 1].range[1]);
      }
    });

    it('splits CJK content on a blank line (\\n\\n)', () => {
      const splitter = new SentenceSplitter();
      const raw =
        '第一段内容讲述了一个非常长的故事大家都很喜欢呢\n\n' + '第二段内容继续讲述另外一个有趣的故事请大家欣赏吧';
      const sentences = feedAll(splitter, [raw]);

      expect(sentences).toHaveLength(2);
      expect(sentences[0].text.startsWith('第一段')).toBe(true);
      expect(sentences[1].text.startsWith('第二段')).toBe(true);
    });
  });

  describe('Latin boundaries and protections', () => {
    it('does not split on Mr. or decimals like 1.5', () => {
      const splitter = new SentenceSplitter();
      const raw =
        'Mr. Smith said the price went up by 1.5 percent yesterday afternoon and everyone was surprised.' +
        ' Then he sat down and ordered another coffee while the meeting continued for a while.';
      const sentences = feedString(splitter, raw, 9);

      expect(sentences.length).toBeGreaterThanOrEqual(1);
      // No sentence should end right after "Mr" or "1" (the protected dots).
      for (const s of sentences) {
        expect(s.text.endsWith('Mr.')).toBe(false);
        expect(s.text.endsWith('1.')).toBe(false);
      }
      // The first emitted sentence should contain both protected tokens.
      expect(sentences[0].text).toContain('Mr. Smith');
      expect(sentences[0].text).toContain('1.5');
    });

    it('does not split on common abbreviations (e.g., i.e., etc., vs., Inc.)', () => {
      const splitter = new SentenceSplitter();
      const raw =
        'There are many fruits, e.g. apples and oranges, and many vegetables, i.e. carrots and beans, etc. for dinner today and tomorrow morning will be even better than yesterday at the office.' +
        ' Acme Inc. vs. Globex Corp was the main topic discussed during the long board meeting earlier this morning at the headquarters downtown.';
      const sentences = feedString(splitter, raw, 11);

      for (const s of sentences) {
        expect(s.text.endsWith('e.g.')).toBe(false);
        expect(s.text.endsWith('i.e.')).toBe(false);
        expect(s.text.endsWith('etc.')).toBe(false);
        expect(s.text.endsWith('vs.')).toBe(false);
        expect(s.text.endsWith('Inc.')).toBe(false);
      }
    });

    it('splits a Latin paragraph on . / ! / ? followed by whitespace', () => {
      const splitter = new SentenceSplitter();
      const raw =
        'This is the first sentence and it is long enough to clear the Latin minimum threshold easily for sure.' +
        ' Is this a question that satisfies the minimum length requirement for the Latin language threshold today?' +
        ' Wow what a great surprise that everyone got to see during the long awaited annual celebration event!';
      const sentences = feedString(splitter, raw, 13);

      expect(sentences).toHaveLength(3);
      expect(sentences[0].text.endsWith('.')).toBe(true);
      expect(sentences[1].text.endsWith('?')).toBe(true);
      expect(sentences[2].text.endsWith('!')).toBe(true);
    });
  });

  describe('Mixed CJK + ASCII threshold', () => {
    it('uses the CJK threshold when CJK proportion >= 40%', () => {
      const splitter = new SentenceSplitter();
      // 20 CJK + a few latin chars — clearly >= 40% CJK, length ~22 so just over min=20.
      const raw = '今天天气非常好我想出去走一走hello。然后吃晚饭。';
      const sentences = feedAll(splitter, [raw]);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      // First emitted sentence sits well under the Latin min (40) but above CJK min (20).
      expect(sentences[0].text.length).toBeLessThan(40);
      expect(sentences[0].text.length).toBeGreaterThanOrEqual(20);
    });

    it('uses the Latin threshold when CJK proportion < 40%', () => {
      const splitter = new SentenceSplitter();
      // A short Latin clause (< 40 chars) should NOT be split despite the period.
      const raw = 'Short one. ';
      const sentences = feedAll(splitter, [raw]);
      expect(sentences).toHaveLength(1);
      // It comes out only via end() flushing the remainder.
      expect(sentences[0].text.trim()).toBe('Short one.');
    });
  });

  describe('Force-split on max', () => {
    it('force-splits when a single Latin sentence exceeds max=240', () => {
      const splitter = new SentenceSplitter();
      const longWord = 'a'.repeat(300); // No boundary, no whitespace, no protections.
      const sentences = feedAll(splitter, [longWord]);

      expect(sentences.length).toBeGreaterThanOrEqual(2);
      // Each non-final emitted sentence must be at or above min (40) and at most max (240).
      for (let i = 0; i < sentences.length - 1; i++) {
        expect(sentences[i].text.length).toBeLessThanOrEqual(240);
        expect(sentences[i].text.length).toBeGreaterThanOrEqual(40);
      }
    });
  });

  describe('end() flushes the remainder', () => {
    it('emits any non-empty remainder as a final sentence on end()', () => {
      const splitter = new SentenceSplitter();
      const a = splitter.push('Hello, world. ');
      const b = splitter.push('Trailing text without a boundary');
      const c = splitter.end();
      const all = [...a, ...b, ...c];
      // Trailing remainder should always come out — even below min — once end() is called.
      expect(all.length).toBeGreaterThanOrEqual(1);
      const last = all[all.length - 1];
      expect(last.text).toContain('Trailing text without a boundary');
    });

    it('returns an empty array when end() is called with an empty buffer', () => {
      const splitter = new SentenceSplitter();
      expect(splitter.end()).toEqual([]);
    });
  });

  describe('URL replacement', () => {
    it('replaces a URL with the literal word "link" in TTS text', () => {
      const splitter = new SentenceSplitter();
      const raw =
        'Please open https://example.com/path?x=1 in your browser right now to continue with the registration process today.';
      const sentences = feedAll(splitter, [raw]);

      const joined = sentences.map((s) => s.text).join(' ');
      expect(joined).toContain('link');
      expect(joined).not.toContain('https://');
      expect(joined).not.toContain('example.com');
    });
  });

  describe('Code fences', () => {
    it('drops fenced code from TTS text but still accounts for it in range offsets', () => {
      const splitter = new SentenceSplitter();
      const prefix = 'Here is some code to consider before reading on please pay close attention. ';
      const code = '```\nconst x = 1;\nconst y = 2;\n```';
      const suffix = ' After the code block we continue talking about something else entirely for clarity now.';
      const raw = prefix + code + suffix;
      const sentences = feedString(splitter, raw, 17);

      for (const s of sentences) {
        expect(s.text).not.toContain('const x');
        expect(s.text).not.toContain('```');
      }
      // The very last emitted sentence covers raw chars up through the suffix's terminator.
      const last = sentences[sentences.length - 1];
      expect(last.range[1]).toBe(raw.length);
      // The first sentence's range covers at least the prefix length.
      expect(sentences[0].range[0]).toBe(0);
    });
  });

  describe('Markdown stripping', () => {
    it('strips heading markers, bold/italic markers, and inline code backticks', () => {
      const splitter = new SentenceSplitter();
      const raw =
        '# Important Title Here\n\n' +
        'This is **bold text** and _italic text_ plus some `inline code` for the demo today right now and after.\n\n';
      const sentences = feedAll(splitter, [raw]);

      const joined = sentences.map((s) => s.text).join(' ');
      expect(joined).not.toMatch(/^#\s|\s#\s/);
      expect(joined).not.toContain('**');
      expect(joined).not.toContain('_italic_');
      expect(joined).not.toContain('`inline');
      expect(joined).toContain('Important Title Here');
      expect(joined).toContain('bold text');
      expect(joined).toContain('italic text');
      expect(joined).toContain('inline code');
    });

    it('drops entire table and image lines from TTS text', () => {
      const splitter = new SentenceSplitter();
      const raw =
        'Read the table below please for the latest data on revenue and please pay close attention to the totals.\n' +
        '| col a | col b |\n' +
        '| ----- | ----- |\n' +
        '| 1     | 2     |\n' +
        '![alt text](https://example.com/img.png)\n' +
        'That is everything we have for the report today thanks so much for reading along carefully.';
      const sentences = feedAll(splitter, [raw]);

      const joined = sentences.map((s) => s.text).join(' ');
      expect(joined).not.toContain('col a');
      expect(joined).not.toContain('-----');
      expect(joined).not.toContain('![');
      expect(joined).not.toContain('img.png');
      expect(joined).toContain('Read the table below');
      expect(joined).toContain('That is everything');
    });

    it('strips leading list markers (- , * , 1. ) but keeps the item text', () => {
      const splitter = new SentenceSplitter();
      const raw =
        '- first item describing something that is reasonably long for the latin threshold to fire correctly here.\n' +
        '* second item describing yet another long thing for the latin threshold to fire correctly as expected.\n' +
        '1. third item describing one more long thing for the latin threshold to fire correctly across the board.\n';
      const sentences = feedAll(splitter, [raw]);

      const joined = sentences.map((s) => s.text).join(' ');
      expect(joined).not.toMatch(/(^|\s)-\s/);
      expect(joined).not.toMatch(/(^|\s)\*\s/);
      expect(joined).not.toMatch(/(^|\s)1\.\s/);
      expect(joined).toContain('first item');
      expect(joined).toContain('second item');
      expect(joined).toContain('third item');
    });

    it('drops sentences that become empty after cleaning', () => {
      const splitter = new SentenceSplitter();
      const raw = '```\nonly code here\nmore code\n```\n\n';
      const sentences = feedAll(splitter, [raw]);
      // Cleaned content is entirely whitespace → nothing should be emitted.
      for (const s of sentences) {
        expect(s.text.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('Error isolation', () => {
    it('returns [] from every subsequent push / end after an internal error', () => {
      const splitter = new SentenceSplitter();
      // Force an exception by monkey-patching an internal RegExp on the prototype chain.
      // We override String.prototype.normalize to throw during one push, simulating an
      // unexpected internal failure. Restore it afterwards so other tests are unaffected.
      const original = String.prototype.normalize;
      let thrown = false;
      Object.defineProperty(String.prototype, 'normalize', {
        configurable: true,
        writable: true,
        value: function (this: string): string {
          throw new Error('boom');
        },
      });
      try {
        // The splitter doesn't have to call normalize itself — instead, we directly poison
        // its internal regex by replacing RegExp.prototype.test for one call.
        const origTest = RegExp.prototype.test;
        RegExp.prototype.test = function (): boolean {
          throw new Error('boom-regex');
        };
        try {
          splitter.push('Hello world. This should blow up internally because regex.test now throws.');
          thrown = true;
        } catch {
          // The splitter must NOT bubble the error.
          thrown = false;
        } finally {
          RegExp.prototype.test = origTest;
        }
      } finally {
        Object.defineProperty(String.prototype, 'normalize', {
          configurable: true,
          writable: true,
          value: original,
        });
      }

      expect(thrown).toBe(true);
      // Once broken, every subsequent call returns an empty array.
      expect(splitter.push('more tokens here. another sentence with enough length to normally split.')).toEqual([]);
      expect(splitter.end()).toEqual([]);
    });
  });
});
