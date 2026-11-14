import type { ErrorCode, SafeError } from '../shared/schemas/index.js';

export class AppError extends Error {
  constructor(readonly code: ErrorCode, readonly fields?: string[]) {
    super(code);
    this.name = 'AppError';
  }
}

export function safeError(error: unknown): SafeError {
  return error instanceof AppError
    ? { code: error.code, ...(error.fields?.length ? { fields: error.fields } : {}) }
    : { code: 'INTERNAL_ERROR' };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('CANCELLED');
}

export function httpStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED': case 'AUTH_EXPIRED': case 'AUTH_INVALID': return 401;
    case 'FORBIDDEN': case 'INVALID_ORIGIN': case 'CSRF_INVALID': case 'AI_DISABLED': return 403;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': case 'CONFIRMATION_EXPIRED': case 'CONFIRMATION_REQUIRED': case 'AI_PRICING_REQUIRED':
    case 'AI_SEARCH_UNAVAILABLE': case 'AI_PROVIDER_AUTH': case 'AI_PROVIDER_UNSUPPORTED':
    case 'AI_INPUT_DISABLED': case 'AI_OUTPUT_UNSUPPORTED': case 'AI_MEDIA_COUNT_UNAVAILABLE': return 409;
    case 'RATE_LIMITED': case 'CAPACITY': case 'AI_PROVIDER_QUOTA': case 'AI_DAILY_LIMIT': case 'AI_BUDGET_LIMIT': return 429;
    case 'AI_CONTEXT_LIMIT': case 'AI_OUTPUT_LIMIT': case 'AI_TOOL_LIMIT': return 422;
    case 'AI_RESPONSE_INCOMPLETE': return 502;
    case 'INVALID_INPUT': return 400;
    case 'TIMEOUT': return 504;
    case 'CANCELLED': return 499;
    case 'UNAVAILABLE': return 503;
    default: return 500;
  }
}
