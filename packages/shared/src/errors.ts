export const ErrorCode = {
  CollectionNotFound: "CollectionNotFoundError",
  CollectionExists: "CollectionExistsError",
  RecordNotFound: "RecordNotFoundError",
  SchemaValidation: "SchemaValidationError",
  FileMissing: "FileMissingError",
  PermissionDenied: "PermissionDeniedError",
  InvalidQuery: "InvalidQueryError",
  Unauthorized: "Unauthorized",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  status: "error";
  error: string;
  message: string;
}

export function errorResponse(error: string, message: string): ApiError {
  return { status: "error", error, message };
}

export class LastSaasError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = code;
  }

  toResponse(): ApiError {
    return errorResponse(this.code, this.message);
  }
}

export class CollectionNotFoundError extends LastSaasError {
  constructor(name: string) {
    super(ErrorCode.CollectionNotFound, `Collection '${name}' not found`);
  }
}

export class CollectionExistsError extends LastSaasError {
  constructor(name: string) {
    super(ErrorCode.CollectionExists, `Collection '${name}' already exists`);
  }
}

export class RecordNotFoundError extends LastSaasError {
  constructor(recordId: string) {
    super(ErrorCode.RecordNotFound, `Record '${recordId}' not found`);
  }
}

export class SchemaValidationError extends LastSaasError {
  constructor(public readonly errors: string[]) {
    super(
      ErrorCode.SchemaValidation,
      `Schema validation failed: ${errors.join("; ")}`,
    );
  }
}

export class FileMissingError extends LastSaasError {
  constructor(fileId: string) {
    super(ErrorCode.FileMissing, `File '${fileId}' not found`);
  }
}

export class PermissionDeniedError extends LastSaasError {
  constructor(message = "Permission denied") {
    super(ErrorCode.PermissionDenied, message);
  }
}

export class InvalidQueryError extends LastSaasError {
  constructor(message: string) {
    super(ErrorCode.InvalidQuery, `Invalid query: ${message}`);
  }
}

export class UnauthorizedError extends LastSaasError {
  constructor(message = "Authentication required") {
    super(ErrorCode.Unauthorized, message);
  }
}
