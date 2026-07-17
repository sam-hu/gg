import { spawnSync } from 'node:child_process';
import chalk from 'chalk';

export interface OutputOptions {
  quiet?: boolean;
}

export class Output {
  readonly quiet: boolean;

  constructor(options: OutputOptions = {}) {
    this.quiet = options.quiet ?? false;
  }

  line(message = ''): void {
    if (!this.quiet) {
      process.stdout.write(`${message}\n`);
    }
  }

  lines(messages: Iterable<string>): void {
    for (const message of messages) this.line(message);
  }

  page(message: string): void {
    if (this.quiet) return;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write(message);
      return;
    }

    const pager = process.env.GG_PAGER || 'less';
    const result = spawnSync(pager, ['-R'], {
      input: message,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, LESS: '-R' },
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stdout.write(message);
        return;
      }
      throw result.error;
    }
  }

  warning(message: string): void {
    if (!this.quiet) {
      process.stdout.write(`${chalk.yellow(`WARNING: ${message}`)}\n`);
    }
  }
}
