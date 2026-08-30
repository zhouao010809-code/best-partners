export const ErrorCode = {
  PathNotAllowed: 'PATH_NOT_ALLOWED',
  VersionConflict: 'VERSION_CONFLICT',
  WriteGateClosed: 'WRITE_GATE_CLOSED',
  SchemaInvalid: 'SCHEMA_INVALID',
  RunAlreadyActive: 'RUN_ALREADY_ACTIVE',
  PlanStale: 'PLAN_STALE',
  RecoveryRequired: 'RECOVERY_REQUIRED',
  StreamReset: 'STREAM_RESET'
} as const;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}
