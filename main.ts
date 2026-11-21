// Sokoban solver: one program answers 5 instances in a single run.
// Each level is a 1-wide hallway with 1-4 rooms off it; a box pushed out of
// a room's door into the hallway can never come back, so every room is an
// independent puzzle and a level's push-optimal count is the sum of its
// rooms' optima. The solver therefore splits each level into rooms and
// solves each room push-optimally with A* over pushes, then joins the rooms'
// solutions with the player's walks between them.
//
// A room search state is the sorted box squares plus the player's reachable
// region (the player walks for free inside a room, so only the region
// matters, not the exact square). The estimate is the cheapest assignment
// of boxes to goals by shortest-path distance, which no push sequence can
// beat, so the first solution A* returns uses the fewest pushes. States
// with a box on a square no box can ever leave, or with a 2x2 block of
// boxes off their goals, are pruned. The search budget is counted in
// expansions, never the clock, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Expansions one room search may spend; far above what these rooms need
// (a few thousand at most on every set tried), low enough that even a
// pathological room cannot eat the run's 60 second wall.
const ROOM_BUDGET = 50_000;
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: Set<number>;
  boxes: number[];
  player: number;
}

interface Room {
  cells: number[];
  cellSet: Set<number>;
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
}

/** Parse an XSB level: # wall, space floor, . goal, $ box, * box on a goal, @ player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if ('.*+'.includes(ch)) goals.add(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

function neighbours(c: number, w: number, h: number): number[] {
  const x = c % w;
  const y = Math.floor(c / w);
  const out: number[] = [];
  if (x > 0) out.push(c - 1);
  if (x < w - 1) out.push(c + 1);
  if (y > 0) out.push(c - w);
  if (y < h - 1) out.push(c + w);
  return out;
}

/**
 * Split a level into its rooms: the connected components of floor squares
 * once the hallway row (the row the player starts on) is taken out. Each
 * component holds its own boxes and goals and opens onto the hallway through
 * exactly one door square; the entry square is the hallway square beside it.
 */
function findRooms(level: Level): Room[] {
  const { w, h, wall, goals, boxes, player } = level;
  const hy = Math.floor(player / w);
  const floor = (i: number): boolean => !wall[i];
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!floor(i) || y === hy || seen.has(i)) continue;
      const cells: number[] = [];
      const stack = [i];
      seen.add(i);
      while (stack.length > 0) {
        const c = stack.pop()!;
        cells.push(c);
        for (const n of neighbours(c, w, h)) {
          if (floor(n) && Math.floor(n / w) !== hy && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      const cellSet = new Set(cells);
      const roomBoxes = boxes.filter((b) => cellSet.has(b));
      const roomGoals = [...goals].filter((g) => cellSet.has(g));
      const doorCells = cells.filter((c) => {
        const cx = c % w;
        const cy = Math.floor(c / w);
        return Math.abs(cy - hy) === 1 && floor(hy * w + cx);
      });
      const door = doorCells[0]!;
      const entry = hy * w + (door % w);
      rooms.push({ cells, cellSet, boxes: roomBoxes, goals: roomGoals, door, entry });
    }
  }
  return rooms;
}

/** Shortest-path distances from a start over passable squares, avoiding blocked ones. */
function bfs(start: number, passable: Set<number>, blocked: Set<number>, w: number, h: number): Map<number, number> {
  const dist = new Map<number, number>([[start, 0]]);
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const d = dist.get(c)! + 1;
    for (const n of neighbours(c, w, h)) {
      if (passable.has(n) && !blocked.has(n) && !dist.has(n)) {
        dist.set(n, d);
        q.push(n);
      }
    }
  }
  return dist;
}

/** The squares the player can walk to from a start, over passable squares avoiding boxes. */
function region(start: number, passable: Set<number>, boxSet: Set<number>, w: number, h: number): Map<number, number> {
  return bfs(start, passable, boxSet, w, h);
}

/**
 * Squares a box can never leave: a square is live when a box on it can be
 * pushed, step by step, onto some goal, with the player free to stand
 * anywhere floor. Found backwards from the goals: a box on c can be pushed
 * onto n (already live) when the player can stand on the square behind it,
 * 2c - n. A box on a square outside this set, off its goal, is lost, so any
 * state holding one is pruned. This catches corners and pockets; it never
 * prunes a square a box could still escape from, since it only assumes the
 * player can stand where floor allows.
 */
function deadCells(room: Room, w: number, h: number): Set<number> {
  const floor = new Set(room.cells);
  floor.add(room.entry);
  const good = new Set(room.goals);
  const q = [...room.goals];
  for (let qi = 0; qi < q.length; qi++) {
    const n = q[qi]!;
    const nx = n % w;
    const ny = Math.floor(n / w);
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d]!;
      const cx = nx - dx;
      const cy = ny - dy;
      const px = nx - 2 * dx;
      const py = ny - 2 * dy;
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
      const c = cy * w + cx;
      const p = py * w + px;
      if (!floor.has(c) || !floor.has(p) || good.has(c)) continue;
      good.add(c);
      q.push(c);
    }
  }
  const dead = new Set<number>();
  for (const c of room.cells) if (!good.has(c)) dead.add(c);
  return dead;
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = [...Array(n).keys()];
  const gen = (k: number): void => {
    if (k === 1) {
      out.push(a.slice());
      return;
    }
    for (let i = 0; i < k; i++) {
      gen(k - 1);
      const j = k % 2 ? 0 : i;
      [a[j], a[k - 1]] = [a[k - 1]!, a[j]!];
    }
  };
  gen(n);
  return out;
}

interface RoomSolution {
  pushes: [number, number][] | null;
  expansions: number;
  overBudget: boolean;
}

/**
 * Push-optimal A* for one room. The player starts on the room's entry
 * square, in the hallway. A state is the sorted box squares and the
 * player's reachable region; a move is one push, cost 1. The estimate is
 * the cheapest assignment of boxes to goals by shortest-path distance
 * (each push moves one box one square, so no sequence can beat it).
 * requireExit asks that the player can still walk out to the entry once
 * every box is on a goal, so the next room stays reachable.
 */
function solveRoom(room: Room, w: number, h: number, requireExit: boolean): RoomSolution {
  const n = room.boxes.length;
  const passable = new Set(room.cells);
  passable.add(room.entry);
  const goalSet = new Set(room.goals);
  const dead = deadCells(room, w, h);
  const distTo = room.goals.map((g) => bfs(g, new Set(room.cells), new Set<number>(), w, h));
  const perms = permutations(n);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = distTo[p[i]!]!.get(boxes[i]!);
        if (d === undefined) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };
  // Four boxes in a 2x2 block can never move again (each one's way out is
  // another box of the block), so a block off its goals is lost.
  const is2x2Dead = (boxSet: Set<number>): boolean => {
    for (const b of boxSet) {
      if (boxSet.has(b + 1) && boxSet.has(b + w) && boxSet.has(b + w + 1)) {
        if (!(goalSet.has(b) && goalSet.has(b + 1) && goalSet.has(b + w) && goalSet.has(b + w + 1))) return true;
      }
    }
    return false;
  };

  // Nodes, kept in parallel arrays: boxes, the player's square, pushes so
  // far, parent node, and the push that made this node.
  const nBoxes: number[][] = [];
  const nPlayer: number[] = [];
  const nG: number[] = [];
  const nParent: number[] = [];
  const nPush: ([number, number] | null)[] = [];
  const closed = new Map<string, number>();
  let seq = 0;
  // Binary heap on (f, -g, insertion order): lowest f first, deeper first on ties.
  const heap: [number, number, number, number][] = [];
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  // The region's lowest square stands for the whole region in a state's key.
  const regionMin = (start: number, boxSet: Set<number>): number => {
    const r = region(start, passable, boxSet, w, h);
    let m = Infinity;
    for (const c of r.keys()) if (c < m) m = c;
    return m;
  };

  const startBoxes = room.boxes.slice().sort((a, b) => a - b);
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return { pushes: null, expansions: 0, overBudget: false };
  const r0 = regionMin(room.entry, new Set(startBoxes));
  nBoxes.push(startBoxes);
  nPlayer.push(room.entry);
  nG.push(0);
  nParent.push(-1);
  nPush.push(null);
  closed.set(startBoxes.join(',') + '|' + r0, 0);
  heapPush([h0, 0, seq++, 0]);

  let expansions = 0;
  while (heap.length > 0) {
    const [, negG, , ni] = heapPop();
    const g = -negG;
    const boxes = nBoxes[ni]!;
    const boxSet = new Set(boxes);
    const reg = region(nPlayer[ni]!, passable, boxSet, w, h);
    let rmin = Infinity;
    for (const c of reg.keys()) if (c < rmin) rmin = c;
    if (closed.get(boxes.join(',') + '|' + rmin) !== ni) continue; // a better path replaced this node
    if (boxes.every((b) => goalSet.has(b))) {
      if (!requireExit || reg.has(room.entry)) {
        const pushes: [number, number][] = [];
        for (let t = ni; t > 0; t = nParent[t]!) pushes.push(nPush[t]!);
        pushes.reverse();
        return { pushes, expansions, overBudget: false };
      }
    }
    if (++expansions > ROOM_BUDGET) return { pushes: null, expansions, overBudget: true };
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d]!;
        const tx = bx + dx;
        const ty = by + dy;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const t = ty * w + tx;
        if (!room.cellSet.has(t) || boxSet.has(t)) continue;
        const px = bx - dx;
        const py = by - dy;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const p = py * w + px;
        if (!passable.has(p) || !reg.has(p)) continue; // the player cannot stand behind the box
        const nb = boxes.slice();
        nb[bi] = t;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        let deadHit = false;
        for (const x of nb) if (dead.has(x)) { deadHit = true; break; }
        if (deadHit) continue;
        if (is2x2Dead(nbSet)) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const k2 = nb.join(',') + '|' + regionMin(b, nbSet);
        const prev = closed.get(k2);
        if (prev !== undefined && nG[prev]! <= g + 1) continue;
        const idx = nBoxes.length;
        nBoxes.push(nb);
        nPlayer.push(b);
        nG.push(g + 1);
        nParent.push(ni);
        nPush.push([b, d]);
        closed.set(k2, idx);
        heapPush([g + 1 + hh, -(g + 1), seq++, idx]);
      }
    }
  }
  return { pushes: null, expansions, overBudget: false };
}

/** The walk (as move letters) from one square to another, avoiding boxes; null when unreachable. */
function walkPath(a: number, b: number, passable: Set<number>, boxSet: Set<number>, w: number, h: number): string | null {
  if (a === b) return '';
  const prev = new Map<number, number | null>([[a, null]]);
  const prevDir = new Map<number, number>();
  const q = [a];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d]!;
      const x = (c % w) + dx;
      const y = Math.floor(c / w) + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const n = y * w + x;
      if (!passable.has(n) || boxSet.has(n) || prev.has(n)) continue;
      prev.set(n, c);
      prevDir.set(n, d);
      q.push(n);
      if (n === b) {
        qi = q.length;
        break;
      }
    }
  }
  if (!prev.has(b)) return null;
  let moves = '';
  for (let c = b; c !== a; c = prev.get(c)!) moves = DIRS[prevDir.get(c)!]![2] + moves;
  return moves;
}

/**
 * Solve one level: solve every room with the exit required, then put any
 * room that cannot be exited last (its boxes may end on its door, shutting
 * the player in, which is fine once no room is left to visit). The moves
 * are the walks between rooms and, inside each room, the walks to each
 * push plus the push itself. A room the search cannot solve leaves the
 * level unsolved, so its moves are left out rather than guessed.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h } = level;
  const rooms = findRooms(level);
  const allFloor = new Set<number>();
  for (let i = 0; i < w * h; i++) if (!level.wall[i]) allFloor.add(i);

  const exitSols = rooms.map((room) => ({ room, sol: solveRoom(room, w, h, true) }));
  let last: { room: Room; sol: RoomSolution } | null = null;
  for (const r of exitSols) {
    if (!r.sol.pushes) {
      const free = solveRoom(r.room, w, h, false);
      if (free.pushes && !last) last = { room: r.room, sol: free };
    }
  }
  const order = exitSols.filter((r) => !last || r.room !== last.room).map((r) => ({ room: r.room, sol: r.sol }));
  if (last) order.push(last);

  let moves = '';
  let player = level.player;
  const boxes = new Set(level.boxes);
  for (let ri = 0; ri < order.length; ri++) {
    const { room, sol } = order[ri]!;
    const isLast = ri === order.length - 1;
    const roomPassable = new Set(room.cells);
    roomPassable.add(room.entry);
    const toEntry = walkPath(player, room.entry, allFloor, boxes, w, h);
    if (toEntry === null) return moves;
    moves += toEntry;
    player = room.entry;
    if (!sol.pushes) continue;
    const roomBoxes = new Set(room.boxes);
    for (const [from, d] of sol.pushes) {
      const [dx, dy] = DIRS[d]!;
      const pusher = from - dy * w - dx;
      const wp = walkPath(player, pusher, roomPassable, roomBoxes, w, h);
      if (wp === null) return moves;
      moves += wp + DIRS[d]![2];
      player = from;
      roomBoxes.delete(from);
      roomBoxes.add(from + dy * w + dx);
    }
    for (const b of room.boxes) boxes.delete(b);
    for (const b of roomBoxes) boxes.add(b);
    if (!isLast) {
      const out = walkPath(player, room.entry, roomPassable, roomBoxes, w, h);
      if (out === null) return moves;
      moves += out;
      player = room.entry;
    }
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
