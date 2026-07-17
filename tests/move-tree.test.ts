import { describe, expect, test } from 'vitest';
import { buildMoveTreeChoices, renderMoveTree, type MoveTree } from '../src/move-tree.js';

describe('buildMoveTreeChoices', () => {
  test('uses one lane for every stack and keeps stacked branches on that lane', () => {
    const children = new Map<string, string[]>([
      ['main', ['samhu/test2', 'stack1-1', 'stack2-1']],
      ['samhu/test2', []],
      ['stack1-1', ['stack1-2']],
      ['stack1-2', []],
      ['stack2-1', []],
    ]);
    const parents = new Map<string, string>([
      ['samhu/test2', 'main'],
      ['stack1-1', 'main'],
      ['stack1-2', 'stack1-1'],
      ['stack2-1', 'main'],
    ]);
    const tree: MoveTree = {
      trunk: 'main',
      parent: (branch) => parents.get(branch),
      children: (branch) => children.get(branch) ?? [],
    };

    const choices = buildMoveTreeChoices(tree, [...children.keys()], false);

    expect(choices.map((choice) => choice.value)).toEqual([
      'samhu/test2',
      'stack1-2',
      'stack1-1',
      'stack2-1',
      'main',
    ]);
    expect(choices.map((choice) => choice.name)).toEqual([
      '○     samhu/test2',
      '│ ○   stack1-2',
      '│ ○   stack1-1',
      '│ │ ○ stack2-1',
      '○─┴─┘ main',
    ]);
  });

  test('joins forked child lanes at their tracked parent', () => {
    const children = new Map<string, string[]>([
      ['main', ['parent']],
      ['parent', ['left', 'right']],
      ['left', []],
      ['right', []],
    ]);
    const tree: MoveTree = {
      trunk: 'main',
      parent: (branch) => (branch === 'main' ? undefined : branch === 'parent' ? 'main' : 'parent'),
      children: (branch) => children.get(branch) ?? [],
    };

    expect(
      buildMoveTreeChoices(tree, [...children.keys()], false).map((choice) => choice.name),
    ).toEqual(['○   left', '│ ○ right', '○─┘ parent', '○   main']);
    expect(renderMoveTree(tree, [...children.keys()], 'parent', false)).toEqual([
      '○   left',
      '│ ○ right',
      '◉─┘ parent (current)',
      '○   main',
    ]);
  });
});
