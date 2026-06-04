/**
 * Conclave — Memory Extractor
 *
 * Distills review comments into actionable conventions using an LLM.
 * Falls back to keyword-grep extraction if the LLM is unavailable.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface ExtractedConvention {
  convention: string;
  category: 'style' | 'architecture' | 'testing' | 'error-handling' | 'naming' | 'docs' | 'performance' | 'security';
  confidence: number;
  evidence: string;
}

export type LlmCallFn = (prompt: string) => Promise<string>;

const VALID_CATEGORIES = ['style', 'architecture', 'testing', 'error-handling', 'naming', 'docs', 'performance', 'security'] as const;

const CONVENTION_KEYWORDS = [
  'naming', 'convention', 'pattern', 'style', 'format',
  'documentation', 'comment', 'type', 'interface', 'schema',
  'error handling', 'validation', 'testing', 'test',
] as const;

// ─── Normalization ──────────────────────────────────────────────

/**
 * Normalize convention text for dedup: lowercase, strip punctuation, collapse whitespace.
 */
export function normalizeConvention(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s/]/g, '')     // strip punctuation except /
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();
}

// ─── MemoryExtractor ────────────────────────────────────────────

export class MemoryExtractor {
  private llmCall: LlmCallFn | null = null;

  /**
   * Set the LLM call function. When not set, only keyword-grep extraction is used.
   */
  setLlmCall(fn: LlmCallFn): void {
    this.llmCall = fn;
  }

  /**
   * Extract actionable conventions from a review submission.
   * Tries LLM first, falls back to keyword-grep on failure.
   * Non-blocking — callers should catch errors.
   */
  async extract(input: {
    taskDescription: string;
    comment: string;
    scores: Record<string, number>;
    suggestions?: string[];
  }): Promise<ExtractedConvention[]> {
    // Try LLM extraction first
    if (this.llmCall) {
      try {
        const conventions = await this.tryLlmExtraction(input);
        if (conventions.length > 0) return conventions;
      } catch (err) {
        console.warn(`  ⚠️ LLM extraction failed, falling back to keyword-grep: ${err}`);
      }
    }

    // Fallback: keyword-grep extraction
    return this.keywordExtraction(input);
  }

  /**
   * Compute a deterministic hash key for a convention text (for dedup).
   */
  getConventionKey(convention: string): string {
    const normalized = normalizeConvention(convention);
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  // ─── LLM Extraction ──────────────────────────────────────────

  private async tryLlmExtraction(input: {
    taskDescription: string;
    comment: string;
    scores: Record<string, number>;
    suggestions?: string[];
  }): Promise<ExtractedConvention[]> {
    const prompt = this.buildExtractionPrompt(input);
    const raw = await this.llmCall!(prompt);
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('LLM response is not an array');
    }

    return parsed.map((item: any) => ({
      convention: String(item.convention ?? ''),
      category: this.validateCategory(item.category),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      evidence: String(item.evidence ?? ''),
    })).filter(c => c.convention.length > 0);
  }

  private buildExtractionPrompt(input: {
    taskDescription: string;
    comment: string;
    scores: Record<string, number>;
    suggestions?: string[];
  }): string {
    return `You are analyzing a code review to extract durable conventions the agent should remember.

Task: ${input.taskDescription}
Review comment: ${input.comment}
Scores: ${JSON.stringify(input.scores)}
Suggestions: ${JSON.stringify(input.suggestions ?? [])}

Extract 0-3 actionable conventions. A convention is a specific rule or pattern
the agent should follow in future work. Examples:
- "Error messages must include a correlation ID" (not "error handling could be better")
- "Use async/await, not .then() chains" (not "style needs work")
- "All public functions need docstrings" (not "add more documentation")

Return as JSON array:
[{ "convention": "...", "category": "style|architecture|testing|error-handling|naming|docs|performance|security", "confidence": 0.0-1.0, "evidence": "quote from comment" }]

Return [] if no actionable conventions found.`;
  }

  // ─── Keyword-Grep Fallback ──────────────────────────────────

  private keywordExtraction(input: {
    comment: string;
    scores: Record<string, number>;
    suggestions?: string[];
  }): ExtractedConvention[] {
    const conventions: ExtractedConvention[] = [];

    // Extract from score extremes
    for (const [dimension, score] of Object.entries(input.scores)) {
      if (score <= 4) {
        conventions.push({
          convention: `Improve ${dimension} — scored ${score}/10`,
          category: this.mapDimensionToCategory(dimension),
          confidence: 0.5,
          evidence: `${dimension} scored low (${score}/10)`,
        });
      }
    }

    // Extract from comment keywords
    if (input.comment) {
      const lowerComment = input.comment.toLowerCase();
      for (const keyword of CONVENTION_KEYWORDS) {
        if (lowerComment.includes(keyword)) {
          conventions.push({
            convention: `Review mentions "${keyword}" — review the feedback for details`,
            category: 'style',
            confidence: 0.4,
            evidence: input.comment.slice(0, 200),
          });
        }
      }
    }

    // Extract from suggestions
    if (input.suggestions && input.suggestions.length > 0) {
      for (const suggestion of input.suggestions) {
        if (suggestion.length > 10) {
          conventions.push({
            convention: suggestion,
            category: 'style',
            confidence: 0.5,
            evidence: `Suggestion: ${suggestion}`,
          });
        }
      }
    }

    return conventions;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private validateCategory(cat: string): ExtractedConvention['category'] {
    if (VALID_CATEGORIES.includes(cat as any)) {
      return cat as ExtractedConvention['category'];
    }
    return 'style';
  }

  private mapDimensionToCategory(dimension: string): ExtractedConvention['category'] {
    const dim = dimension.toLowerCase();
    if (dim.includes('test')) return 'testing';
    if (dim.includes('security')) return 'security';
    if (dim.includes('perform')) return 'performance';
    if (dim.includes('doc')) return 'docs';
    if (dim.includes('name')) return 'naming';
    if (dim.includes('error') || dim.includes('handl')) return 'error-handling';
    if (dim.includes('arch')) return 'architecture';
    return 'style';
  }
}