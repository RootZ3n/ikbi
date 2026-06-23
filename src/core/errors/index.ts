/**
 * ikbi error translation — public surface.
 *
 * Re-exports the error-translation layer so callers import from `core/errors` rather
 * than reaching into the implementation file.
 */

export {
  classifyError,
  translateError,
  formatFriendlyError,
  type ErrorCategory,
  type FriendlyError,
  type TranslateOptions,
} from "./translator.js";
