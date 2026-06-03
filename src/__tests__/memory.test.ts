import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryService } from '../services/memory.js';

// Mock the crypto module
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234-5678-abcd-ef0123456789',
}));

// Helper to create a chainable mock for Drizzle query builder
const createQueryBuilder = (returnValue: any) => {
  const mockWhere = vi.fn(() => ({
    limit: vi.fn(() => Promise.resolve(returnValue)),
  }));
  return {
    where: mockWhere,
    limit: vi.fn(() => Promise.resolve(returnValue)),
  };
};

describe('MemoryService', () => {
  let memoryService: MemoryService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => createQueryBuilder([])),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.resolve()),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    };
  });

  describe('upsert', () => {
    it('should insert a new memory entry when it does not exist', async () => {
      // Setup mock to return empty (no existing entry)
      const emptyResults = createQueryBuilder([]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => emptyResults),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.upsert({
        principalId: 'usr_test123',
        key: 'test:key:value',
        value: 'test value',
        category: 'test',
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('mem_testuuid12345678abcdef01');
      expect(result.principalId).toBe('usr_test123');
      expect(result.key).toBe('test:key:value');
      expect(result.value).toBe('test value');
      expect(result.category).toBe('test');
      expect(result.updatedAt).toBeDefined();

      // Verify insert was called
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should update an existing memory entry when it already exists', async () => {
      const existingEntry = {
        id: 'mem_existing123',
        principalId: 'usr_test123',
        key: 'test:key:value',
        value: 'old value',
        category: 'test',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      // Setup mock to return existing entry
      const existingResults = createQueryBuilder([existingEntry]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => existingResults),
      });
      mockDb.update.mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.upsert({
        principalId: 'usr_test123',
        key: 'test:key:value',
        value: 'new value',
      });

      expect(result).toBeDefined();
      expect(result.value).toBe('new value');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should use default category when category is not provided', async () => {
      const emptyResults = createQueryBuilder([]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => emptyResults),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.upsert({
        principalId: 'usr_test123',
        key: 'test:key',
        value: 'some value',
      });

      expect(result.category).toBe('general');
    });
  });

  describe('getByPrincipal', () => {
    it('should return all memory entries for a principal', async () => {
      const entries = [
        { id: 'mem_1', principalId: 'usr_123', key: 'key1', value: 'val1', category: 'general', updatedAt: '2024-01-01' },
        { id: 'mem_2', principalId: 'usr_123', key: 'key2', value: 'val2', category: 'general', updatedAt: '2024-01-01' },
      ];

      // getByPrincipal uses .where() without .limit(), so we need to mock where to return the promise directly
      const mockFrom = vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(entries)),
      }));

      mockDb.select.mockReturnValue({
        from: mockFrom,
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.getByPrincipal('usr_123');

      expect(result).toEqual(entries);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('getByKey', () => {
    it('should return a single memory entry by principal and key', async () => {
      const entry = { id: 'mem_1', principalId: 'usr_123', key: 'key1', value: 'val1', category: 'general', updatedAt: '2024-01-01' };

      const results = createQueryBuilder([entry]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => results),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.getByKey('usr_123', 'key1');

      expect(result).toEqual(entry);
    });

    it('should return undefined when no entry exists', async () => {
      const emptyResults = createQueryBuilder([]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => emptyResults),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.getByKey('usr_123', 'nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should return true and delete when entry exists', async () => {
      const entry = { id: 'mem_1', principalId: 'usr_123', key: 'key1', value: 'val1', category: 'general', updatedAt: '2024-01-01' };

      const results = createQueryBuilder([entry]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => results),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.delete('usr_123', 'key1');

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('should return false when entry does not exist', async () => {
      const emptyResults = createQueryBuilder([]);
      mockDb.select.mockReturnValue({
        from: vi.fn(() => emptyResults),
      });

      memoryService = new MemoryService(mockDb);

      const result = await memoryService.delete('usr_123', 'nonexistent');

      expect(result).toBe(false);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });
});
