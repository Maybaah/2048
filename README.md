# 2048

Slide-and-merge puzzle for the [maybaah.github.io](https://maybaah.github.io/)
arcade: combine matching tiles until you reach 2048, then keep going. Vanilla
JS, no build step, no dependencies.

**Play:** https://maybaah.github.io/2048/

## How it fits together

This repo deploys as a project page under the root site's domain. It loads the
shared design system and arcade client (`/assets/site.css`, `/assets/arcade.js`)
from [Maybaah/Maybaah.github.io](https://github.com/Maybaah/Maybaah.github.io),
so it must be served under that domain to look and score right.

Tile spawns come from a seeded PRNG and every effective move is appended to a
tape (a string of `u`/`d`/`l`/`r`). On game over the run submits
`{seed, moves}` and nothing else: the Worker replays the tape from the seed,
computes the score itself and rejects anything that does not end in a jammed
board. Same never-trust-the-client model as
[flowcode](https://github.com/Maybaah/flowcode).

The value-level rules here (slide order, merge order, spawn choice) are
mirrored in the Worker, so `game.js` and `worker/src/index.js` in the site repo
have to stay in step.

## One undo

A run gets one step back, on the **Undo** button or the `Z` key, and only while
the board is still alive. Nothing here can rewind the generator, so the undo
drops the last letter of the tape and replays the run from its own seed. What
is left is a real prefix of the tape that was already there, which is exactly
what the Worker replays, so an undone run stays verifiable and lands on the
board like any other.

- 4x4 grid, new tile is 2 (90%) or 4 (10%)
- Arrow keys, WASD, or swipe on touch
- Local run history lives in `localStorage` and feeds the arcade hub card
- A finished run pays arcade coins, spendable in [`/shop/`](https://maybaah.github.io/shop/)
