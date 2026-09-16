#!/usr/bin/env bun
/** @module bin — the `browserhive` executable: builds the production CLI dependencies and runs the planned command (spec 08 §7) */
import { main } from './cli/production/deps.ts';

await main();
