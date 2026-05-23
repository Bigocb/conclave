/**
 * Conclave — Response envelope helper
 */

import { randomUUID } from 'crypto';

export function success(data: any, metaOverrides: Record<string, unknown> = {}) {
  return {
    status: 'success',
    data,
    meta: {
      request_id: `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      timestamp: new Date().toISOString(),
      ...metaOverrides,
    },
  };
}

export function error(code: string, message: string, details?: Record<string, unknown>, statusCode: number = 400) {
  return {
    status: 'error',
    error: {
      code,
      message,
      details: details ?? {},
    },
  };
}

export const ERROR_CODES = {
  INSUFFICIENT_BUDGET: { code: 'INSUFFICIENT_BUDGET', status: 402 },
  PRINCIPAL_NOT_FOUND: { code: 'PRINCIPAL_NOT_FOUND', status: 404 },
  DUPLICATE_REVIEW: { code: 'DUPLICATE_REVIEW', status: 409 },
  AGENT_NOT_FOUND: { code: 'AGENT_NOT_FOUND', status: 404 },
  TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', status: 404 },
  SELF_REVIEW_FORBIDDEN: { code: 'SELF_REVIEW_FORBIDDEN', status: 403 },
  INVALID_DIMENSIONS: { code: 'INVALID_DIMENSIONS', status: 422 },
  INVALID_SCORE: { code: 'INVALID_SCORE', status: 422 },
  COMMENT_TOO_SHORT: { code: 'COMMENT_TOO_SHORT', status: 422 },
  CHANNEL_NOT_FOUND: { code: 'CHANNEL_NOT_FOUND', status: 404 },
  UNAUTHORIZED: { code: 'UNAUTHORIZED', status: 401 },
  FORBIDDEN: { code: 'FORBIDDEN', status: 403 },
  NOT_SUBSCRIBED: { code: 'NOT_SUBSCRIBED', status: 403 },
  DEADLINE_PASSED: { code: 'DEADLINE_PASSED', status: 422 },
  TASK_ALREADY_COMPLETED: { code: 'TASK_ALREADY_COMPLETED', status: 409 },
  INVALID_TRANSITION: { code: 'INVALID_TRANSITION', status: 422 },
} as const;
