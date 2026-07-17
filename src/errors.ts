export class UserError extends Error {
  readonly exitCode: number;
  readonly raw: boolean;

  constructor(message: string, options: { exitCode?: number; raw?: boolean } = {}) {
    super(message);
    this.name = 'UserError';
    this.exitCode = options.exitCode ?? 1;
    this.raw = options.raw ?? false;
  }
}

export function ggError(message: string): UserError {
  const rendered = message
    .split('\n')
    .map((line, index) => (index === 0 ? `ERROR: ${line} ` : line))
    .join('\n');
  return new UserError(rendered, { raw: true });
}

export function assertUser(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw ggError(message);
  }
}
