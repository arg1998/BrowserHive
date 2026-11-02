#!/usr/bin/env bun
/** @module bin — the `browserhive` executable (also installed as `bh`, the shorthand): builds the production CLI dependencies and runs the planned command (spec 08 §7) */
import { main } from './cli/production/deps.ts';

await main();
