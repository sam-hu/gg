import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { selectWithEscape } from '../src/prompts.js';

describe('selectWithEscape', () => {
  test('returns without a selection when Escape is pressed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      rendered += chunk;
    });
    const selection = selectWithEscape(
      {
        message: 'Choose a branch',
        choices: [
          { activeName: 'ACTIVE main', name: 'main', value: 'main' },
          { name: 'query-branch', value: 'query-branch' },
        ],
      },
      { input, output },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rendered).toContain('ACTIVE main');
    expect(rendered).not.toContain('? Choose a branch');
    const startedAt = performance.now();
    input.write('\u001b');

    await expect(selection).resolves.toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('ignores typed characters and moves only with arrow keys', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      rendered += chunk;
    });
    const selection = selectWithEscape(
      {
        message: 'Choose a branch',
        choices: [
          { name: '○     main', short: 'main', value: 'main' },
          { name: '│  ○  query-one', short: 'query-one', value: 'query-one' },
          { name: '│  ○  query-two', short: 'query-two', value: 'query-two' },
        ],
      },
      { input, output },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write('query-two');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rendered).not.toContain('Search:');
    input.write('\u001b[B');
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write('\r');

    await expect(selection).resolves.toBe('query-one');
  });
});
