/** @module kernel/errors — named exports of the error kernel (AppError + serializer). */

export {
  AppError,
  type AppErrorOptions,
  assertNever,
  errorFrom,
  expect,
  isAppError,
} from './app-error.ts';
export {
  MAX_CAUSE_DEPTH,
  type SerializedError,
  type SerializeErrorOptions,
  serializeError,
} from './serialize-error.ts';
