/**
 * ikbi step-planner — config.
 */

/** Maximum number of steps a goal can be decomposed into. */
export const MAX_STEPS = 10;

/**
 * Heuristic thresholds for detecting "complex" goals that need decomposition.
 * A goal is complex if it matches multiple indicators.
 */
export const COMPLEX_INDICATORS: readonly RegExp[] = [
  /\band\b.*\band\b/i,                    // "do X and Y and Z"
  /,\s*(?:also|then|additionally|plus)/i,  // "do X, also Y, plus Z"
  /\b(?:step|phase)\s*\d/i,               // "step 1: ... step 2: ..."
  /\b\d+\.\s+\w/i,                         // "1. do X\n2. do Y"
  /\b(?:first|then|finally)\b.*\b(?:first|then|finally)\b/i, // "first X, then Y, finally Z"
  /\badd\b.*\b(?:test|doc|readme)\b.*\b(?:add|update)\b/i,  // "add X and add test and update docs"
];

/** Minimum number of indicators to consider a goal "complex". */
export const COMPLEX_THRESHOLD = 1;
