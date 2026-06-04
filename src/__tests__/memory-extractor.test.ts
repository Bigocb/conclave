import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryExtractor, normalizeConvention, type ExtractedConvention } from '../services/memory-extractor.js';

describe('MemoryExtractor', () => {
  let extractor: MemoryExtractor;

  beforeEach(() => {
    extractor = new MemoryExtractor();
  });

  describe('extract', () => {
    const baseInput = {
      taskDescription: 'Implement user authentication endpoint',
      comment: 'Good work overall. A few things: use async/await consistently instead of .then() chains. Also, all public functions should have JSDoc comments. The error handling could be better — use specific error types instead of generic Error.',
      scores: { correctness: 8, style: 6, testing: 7 },
      suggestions: ['Replace .then() with async/await', 'Add JSDoc to public functions', 'Use custom error classes'],
    };

    it('should return extracted conventions from LLM response', async () => {
      const mockLlmResponse: ExtractedConvention[] = [
        { convention: 'Use async/await consistently instead of .then() chains', category: 'style', confidence: 0.9, evidence: 'Replace .then() with async/await' },
        { convention: 'Add JSDoc comments to all public functions', category: 'docs', confidence: 0.8, evidence: 'Add JSDoc to public functions' },
        { convention: 'Use specific error types instead of generic Error', category: 'error-handling', confidence: 0.7, evidence: 'Use custom error classes' },
      ];

      const mockLlmCall = vi.fn().mockResolvedValue(JSON.stringify(mockLlmResponse));
      extractor.setLlmCall(mockLlmCall);

      const result = await extractor.extract(baseInput);

      expect(result).toHaveLength(3);
      expect(result[0].convention).toBe('Use async/await consistently instead of .then() chains');
      expect(result[0].category).toBe('style');
      expect(result[0].confidence).toBe(0.9);
      expect(result[1].category).toBe('docs');
      expect(result[2].category).toBe('error-handling');

      expect(mockLlmCall).toHaveBeenCalledTimes(1);
      const callArg = mockLlmCall.mock.calls[0][0];
      expect(callArg).toContain('Implement user authentication endpoint');
      expect(callArg).toContain('Good work overall');
      expect(callArg).toContain('correctness');
    });

    it('should fall back to keyword-grep when LLM call throws', async () => {
      const mockLlmCall = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
      extractor.setLlmCall(mockLlmCall);

      const result = await extractor.extract(baseInput);

      expect(result.length).toBeGreaterThanOrEqual(1);
      // Should have found keyword "error handling" from the comment
      expect(result.some(c => c.convention.includes('error handling'))).toBe(true);
      expect(mockLlmCall).toHaveBeenCalledTimes(1);
    });

    it('should fall back to keyword-grep when LLM returns invalid JSON', async () => {
      const mockLlmCall = vi.fn().mockResolvedValue('not valid json');
      extractor.setLlmCall(mockLlmCall);

      const result = await extractor.extract(baseInput);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(mockLlmCall).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no conventions found', async () => {
      const input = {
        taskDescription: 'Simple typo fix',
        comment: 'Looks good, approved.',
        scores: { correctness: 9, style: 9 },
        suggestions: [],
      };

      // No LLM set — falls to keyword-grep, which should find nothing in this comment
      const result = await extractor.extract(input);
      expect(result).toEqual([]);
    });

    it('should fall back immediately to keyword-grep when no LLM call is configured', async () => {
      // No LLM call configured
      const result = await extractor.extract(baseInput);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('normalizeConvention', () => {
    it('should lowercase and strip punctuation', () => {
      const result = normalizeConvention('Use Async/Await!');
      expect(result).toBe('use async/await');
    });

    it('should collapse whitespace', () => {
      const result = normalizeConvention('use   async/await   everywhere');
      expect(result).toBe('use async/await everywhere');
    });

    it('should trim leading/trailing whitespace', () => {
      const result = normalizeConvention('  use async/await  ');
      expect(result).toBe('use async/await');
    });
  });

  describe('getConventionKey', () => {
    it('should produce consistent hash for same convention', () => {
      const key1 = extractor.getConventionKey('Use async/await consistently');
      const key2 = extractor.getConventionKey('Use async/await consistently');
      expect(key1).toBe(key2);
    });

    it('should produce same hash for normalized equivalents', () => {
      const key1 = extractor.getConventionKey('Use async/await consistently!');
      const key2 = extractor.getConventionKey('  use async/await consistently');
      expect(key1).toBe(key2);
    });

    it('should produce different hashes for different conventions', () => {
      const key1 = extractor.getConventionKey('Use async/await');
      const key2 = extractor.getConventionKey('Add JSDoc comments');
      expect(key1).not.toBe(key2);
    });
  });
});