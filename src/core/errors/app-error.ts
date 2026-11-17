import { ERRORS, type ErrorCode } from './catalog';

export interface ErrorDetail {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message ?? ERRORS[code].message);
    this.name = 'AppError';
    this.status = ERRORS[code].status;
  }
}
