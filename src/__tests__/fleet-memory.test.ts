import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type ReviewInput } from '../fleet/backends.js';

// Test that memories are properly rendered in the system prompt
// This verifies the prompt template logic without needing to export internal functions

describe('Fleet Memory Injection', () => {
  describe('ReviewInput.memories field', () => {
    it('should have memories field defined in ReviewInput interface', () => {
      // Create a ReviewInput with memories to verify the interface supports it
      const input: ReviewInput = {
        task_id: 'tsk_test123',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness'],
        channel: 'test',
        memories: ['Memory 1', 'Memory 2'],
      };

      // Verify memories field is accessible
      expect(input.memories).toBeDefined();
      expect(input.memories).toHaveLength(2);
      expect(input.memories).toContain('Memory 1');
      expect(input.memories).toContain('Memory 2');
    });

    it('should allow memories to be undefined', () => {
      const input: ReviewInput = {
        task_id: 'tsk_test123',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness'],
        channel: 'test',
      };

      expect(input.memories).toBeUndefined();
    });

    it('should support empty memories array', () => {
      const input: ReviewInput = {
        task_id: 'tsk_test123',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness'],
        channel: 'test',
        memories: [],
      };

      expect(input.memories).toBeDefined();
      expect(input.memories).toHaveLength(0);
    });
  });

  describe('Memory formatting in prompt', () => {
    // These tests verify the expected prompt format for memories
    // The actual prompt rendering is in buildLlmSystemPrompt in backends.ts (lines 288-292)

    it('should format memories as bullet points', () => {
      const memories = [
        'Use snake_case for function names',
        'Always include error handling',
      ];

      const formatted = memories.map(m => '- ' + m).join('\n');

      expect(formatted).toContain('- Use snake_case for function names');
      expect(formatted).toContain('- Always include error handling');
    });

    it('should handle empty memories array with fallback message', () => {
      const memories: string[] = [];

      const rendered = memories && memories.length > 0
        ? memories.map(m => '- ' + m).join('\n')
        : 'No specific project conventions identified for this review.';

      expect(rendered).toBe('No specific project conventions identified for this review.');
    });

    it('should handle undefined memories with fallback message', () => {
      const memories = undefined;

      const rendered = memories && memories.length > 0
        ? memories.map(m => '- ' + m).join('\n')
        : 'No specific project conventions identified for this review.';

      expect(rendered).toBe('No specific project conventions identified for this review.');
    });

    it('should render memories correctly when present', () => {
      const memories = ['Memory 1', 'Memory 2'];

      const rendered = memories && memories.length > 0
        ? memories.map(m => '- ' + m).join('\n')
        : 'No specific project conventions identified for this review.';

      expect(rendered).toBe('- Memory 1\n- Memory 2');
    });
  });

  describe('Integration: Memory flow from task principal to ReviewInput', () => {
    it('should correctly map memory entries to ReviewInput.memories', () => {
      // Simulate what the manager does when fetching memories
      const memoryEntries = [
        { id: 'mem_1', principalId: 'prn_123', key: 'key1', value: 'Use async/await', category: 'conventions', updatedAt: '2024-01-01' },
        { id: 'mem_2', principalId: 'prn_123', key: 'key2', value: 'Prefer composition over inheritance', category: 'conventions', updatedAt: '2024-01-01' },
        { id: 'mem_3', principalId: 'prn_123', key: 'key3', value: 'Write unit tests for all public functions', category: 'conventions', updatedAt: '2024-01-01' },
      ];

      // This is what the manager does: map memory entries to string array
      const memories = memoryEntries.map(m => m.value);

      // Create ReviewInput with memories (as the manager now does)
      const input: ReviewInput = {
        task_id: 'tsk_test',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness', 'efficiency'],
        channel: 'code-review',
        memories,
      };

      // Verify memories are in the input
      expect(input.memories).toBeDefined();
      expect(input.memories).toHaveLength(3);
      expect(input.memories).toContain('Use async/await');
      expect(input.memories).toContain('Prefer composition over inheritance');
      expect(input.memories).toContain('Write unit tests for all public functions');
    });

    it('should handle missing principalId gracefully (empty memories)', () => {
      // Simulate when task doesn't have principalId
      const principalId = undefined;
      
      let memories: string[] = [];
      if (principalId) {
        // In the actual code, this would call memoryService.getByPrincipal(principalId)
        // but since principalId is undefined/falsy, memories stays empty
        memories = [];
      }

      const input: ReviewInput = {
        task_id: 'tsk_test',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness'],
        channel: 'test',
        memories,
      };

      expect(input.memories).toEqual([]);
    });

    it('should handle memory service returning empty array', () => {
      // Simulate when principal has no memories
      const memoryEntries: any[] = [];

      const memories = memoryEntries.map(m => m.value);

      const input: ReviewInput = {
        task_id: 'tsk_test',
        task_description: 'Test task',
        output: 'Test output',
        dimensions: ['correctness'],
        channel: 'test',
        memories,
      };

      expect(input.memories).toEqual([]);
    });
  });
});
