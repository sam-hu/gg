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

  raw(message: string): void {
    if (!this.quiet) {
      process.stdout.write(message);
    }
  }

  warning(message: string): void {
    if (!this.quiet) {
      process.stdout.write(`${chalk.yellow(`WARNING: ${message}`)}\n`);
    }
  }

  error(message: string): void {
    process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  }
}
