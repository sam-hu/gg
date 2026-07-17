import { emitKeypressEvents, type Interface } from 'node:readline';
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
} from '@inquirer/core';
import chalk from 'chalk';

const ESCAPE_CODE_TIMEOUT_MS = 50;

interface SelectChoice<Value> {
  activeName?: string;
  name: string;
  short?: string;
  value: Value;
}

interface SelectWithEscapeConfig<Value> {
  message: string;
  choices: readonly SelectChoice<Value>[];
  default?: Value;
  pageSize?: number;
  loop?: boolean;
}

interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function selectWithEscape<Value>(
  config: SelectWithEscapeConfig<Value>,
  streams: PromptStreams = {},
): Promise<Value | undefined> {
  const input = streams.input ?? process.stdin;
  const controller = new AbortController();
  let escaped = false;
  const onKeypress = (_character: string | undefined, key: { name?: string }): void => {
    if (key.name !== 'escape') return;
    escaped = true;
    controller.abort();
  };

  // Node otherwise waits 500 ms to distinguish Esc from an ANSI key sequence.
  emitKeypressEvents(input, {
    escapeCodeTimeout: ESCAPE_CODE_TIMEOUT_MS,
  } as unknown as Interface);
  input.on('keypress', onKeypress);
  try {
    const promptContext = streams.output
      ? { input, output: streams.output, signal: controller.signal }
      : { input, signal: controller.signal };
    return await createArrowSelect<Value>()(config, promptContext);
  } catch (error) {
    if (escaped && error instanceof Error && error.name === 'AbortPromptError') return undefined;
    throw error;
  } finally {
    input.removeListener('keypress', onKeypress);
  }
}

function createArrowSelect<Value>() {
  return createPrompt<Value, SelectWithEscapeConfig<Value>>((config, done) => {
    const { loop = true, pageSize = 7 } = config;
    const theme = makeTheme({
      prefix: { idle: '' },
      icon: { cursor: '❯' },
    });
    const choices = useMemo(() => config.choices, [config.choices]);
    if (choices.length === 0) throw new Error('No branches are available to select.');
    const defaultIndex = useMemo(() => {
      if (!('default' in config)) return -1;
      return choices.findIndex((choice) => choice.value === config.default);
    }, [choices, config.default]);
    const [active, setActive] = useState(defaultIndex < 0 ? 0 : defaultIndex);
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const selected = choices[active]!;
    const prefix = usePrefix({ status, theme });

    useKeypress((key, readline) => {
      if (isEnterKey(key)) {
        setStatus('done');
        done(selected.value);
        return;
      }
      if (isUpKey(key, theme.keybindings) || isDownKey(key, theme.keybindings)) {
        readline.clearLine(0);
        const offset = isUpKey(key, theme.keybindings) ? -1 : 1;
        const next = active + offset;
        if (loop) setActive((next + choices.length) % choices.length);
        else setActive(Math.max(0, Math.min(choices.length - 1, next)));
        return;
      }
      readline.clearLine(0);
    });

    const message = theme.style.message(config.message, status);
    if (status === 'done') {
      return [prefix, message, theme.style.answer(selected.short ?? selected.name)]
        .filter(Boolean)
        .join(' ');
    }
    const page = usePagination({
      items: choices,
      active,
      pageSize,
      loop,
      renderItem({ item, isActive }) {
        const cursor = isActive ? chalk.cyan(theme.icon.cursor) : ' ';
        return `${cursor} ${isActive ? (item.activeName ?? chalk.underline(item.name)) : item.name}`;
      },
    });
    return `${[prefix, message].filter(Boolean).join(' ')}\n${page}\n\u001B[?25l`;
  });
}
