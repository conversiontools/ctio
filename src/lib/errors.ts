export const ExitCode = {
  Ok: 0,
  GenericError: 1,
  UsageError: 2,
  AuthError: 3,
  NotFound: 4,
  ApiError: 5,
  IoError: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CtioError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint?: string;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.GenericError, hint?: string) {
    super(message);
    this.name = "CtioError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class AuthMissingError extends CtioError {
  constructor() {
    super(
      "No API token found.",
      ExitCode.AuthError,
      "Run `ctio auth login` or set CT_API_TOKEN.",
    );
    this.name = "AuthMissingError";
  }
}

export class AuthInvalidError extends CtioError {
  constructor(detail?: string) {
    super(
      detail ? `Authentication failed: ${detail}` : "Authentication failed.",
      ExitCode.AuthError,
      "Your token may have been regenerated. Run `ctio auth login` to update.",
    );
    this.name = "AuthInvalidError";
  }
}

export class UsageError extends CtioError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.UsageError, hint);
    this.name = "UsageError";
  }
}

export class IoError extends CtioError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.IoError, hint);
    this.name = "IoError";
  }
}
