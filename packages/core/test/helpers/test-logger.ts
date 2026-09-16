/** @module test/helpers/test-logger — the collecting logger for domain/app suites (keeps test files off the infra layer). */

export {
  type CollectedRecord,
  type CollectingLogger,
  createCollectingLogger,
} from '../../src/infra/logging/collecting-logger.ts';
