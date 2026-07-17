import chalk from 'chalk';
import { ggError } from './errors.js';

export interface MoveTree {
  trunk: string;
  parent(branch: string): string | undefined;
  children(branch: string): string[];
}

export interface MoveTreeChoice {
  activeName: string;
  name: string;
  short: string;
  value: string;
}

interface LayoutRow {
  branch: string;
  lane: number;
  childLanes: number[];
  root: boolean;
}

const laneColors: Array<(text: string) => string> = [
  chalk.cyan,
  chalk.green,
  chalk.rgb(105, 180, 0),
  chalk.yellow,
  chalk.magenta,
  chalk.blue,
  chalk.red,
];

export function buildMoveTreeChoices(
  tree: MoveTree,
  candidates: readonly string[],
  colors = true,
): MoveTreeChoice[] {
  const included = new Set(candidates);
  const orderedCandidates = [...included];
  const roots = orderedCandidates
    .filter((branch) => !included.has(tree.parent(branch) ?? ''))
    .toSorted((left, right) => rootRank(tree, left) - rootRank(tree, right));
  const rows: LayoutRow[] = [];
  const lanes = new Map<string, number>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let nextLane = 0;

  const visit = (branch: string, root: boolean): number => {
    if (visiting.has(branch)) throw ggError('Tracked branch metadata contains a cycle.');
    const assigned = lanes.get(branch);
    if (assigned !== undefined) return assigned;
    visiting.add(branch);
    const childLanes = tree
      .children(branch)
      .filter((child) => included.has(child))
      .map((child) => visit(child, false));
    const lane = childLanes[0] ?? nextLane++;
    lanes.set(branch, lane);
    rows.push({ branch, lane, childLanes, root });
    visiting.delete(branch);
    visited.add(branch);
    return lane;
  };

  for (const root of roots) visit(root, true);
  // Inconsistent metadata can contain a tracked row that its recorded parent
  // does not list as a child. Keep it selectable as a separate component.
  for (const branch of orderedCandidates.toSorted()) {
    if (!visited.has(branch)) visit(branch, true);
  }

  const open = Array.from({ length: nextLane }, () => false);
  return rows.map(({ branch, lane, childLanes, root }) => {
    const cells = renderCells(open, lane, childLanes, colors, false);
    const activeCells = renderCells(open, lane, childLanes, colors, true);
    for (const childLane of childLanes) open[childLane] = childLane === lane;
    open[lane] = !root;
    return {
      activeName: `${activeCells}${styleActiveLabel(lane, branch, colors)}`,
      name: `${cells}${colorLane(lane, branch, colors)}`,
      short: branch,
      value: branch,
    };
  });
}

export function renderMoveTree(
  tree: MoveTree,
  candidates: readonly string[],
  current: string,
  colors = true,
): string[] {
  return buildMoveTreeChoices(tree, candidates, colors).map((choice) => {
    if (choice.value !== current) return choice.name;
    const line = choice.activeName.replace('○', '◉');
    return `${line}${colors ? chalk.cyan(' (current)') : ' (current)'}`;
  });
}

function renderCells(
  open: readonly boolean[],
  lane: number,
  childLanes: readonly number[],
  colors: boolean,
  active: boolean,
): string {
  const joining = childLanes.length > 1;
  const lastChildLane = joining ? Math.max(...childLanes) : lane;
  const childLaneSet = new Set(childLanes);
  const cells: string[] = [];
  for (let index = 0; index < open.length; index += 1) {
    let cell = '  ';
    if (joining && index >= lane && index <= lastChildLane) {
      if (index === lane) cell = '○─';
      else if (index === lastChildLane) cell = '┘ ';
      else if (childLaneSet.has(index)) cell = '┴─';
      else cell = '──';
    } else if (index === lane) {
      cell = '○ ';
    } else if (open[index]) {
      cell = '│ ';
    }
    if (active && index >= lane) {
      cells.push(colors ? colorLane(lane, chalk.underline(cell), true) : cell);
    } else {
      cells.push(cell.trim() ? colorLane(index, cell, colors) : cell);
    }
  }
  return cells.join('');
}

function styleActiveLabel(lane: number, text: string, colors: boolean): string {
  return colors ? colorLane(lane, chalk.underline(text), true) : text;
}

function colorLane(lane: number, text: string, colors: boolean): string {
  if (!colors) return text;
  return laneColors[lane % laneColors.length]!(text);
}

function rootRank(tree: MoveTree, branch: string): number {
  return branch === tree.trunk ? -1 : 0;
}
