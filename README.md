# Sokoban Solver

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/1Serv0x/sokoban-solver-20261121/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/1Serv0x/sokoban-solver-20261121/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [sokoban-solver-01-run-20261121 bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) on [make.fun](https://make.fun). It answers all 5 instances of a set in one run, in as few pushes as possible.

## How it works

Each level is a 1-wide hallway with 1–4 rooms off it, and a box pushed out of a room's door into the hallway can never come back — so every room is an independent puzzle, and a level's push-optimal count is the sum of its rooms' optima. The solver:

1. **Splits the level into rooms** — the connected components of floor squares once the hallway row is taken out. Each room has one door and one entry square from the hallway.
2. **Solves each room push-optimally with A\*** over pushes. A state is the sorted box squares plus the player's reachable region (walking is free, so only the region matters). The estimate is the cheapest assignment of boxes to goals by shortest-path distance, which no push sequence can beat, so the first solution found uses the fewest pushes. States with a box on a square it can never leave, or a 2×2 block of boxes off their goals, are pruned.
3. **Joins the rooms** with the player's walks between them, requiring the player to still be able to walk out of each room (except the last) once its boxes are on their goals.

The search budget is counted in expansions, never the clock, so two runs write the same bytes. On the kit's practice set it scores 1,000,000 — every level solved in exactly its push-optimal count — and it did the same on three further sets drawn from the published generator.

## Run it

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

Local run against the practice set:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, no dependencies, no network. `main.ts` is the whole entry.
