/** @module contracts/enums/transport — MCP transport kinds */
import { z } from 'zod';

/** The MCP transport a server process runs: never both in one process (D-02). */
export const Transport = z.enum(['stdio', 'http']);
/** Union of {@link Transport} values. */
export type Transport = z.infer<typeof Transport>;
