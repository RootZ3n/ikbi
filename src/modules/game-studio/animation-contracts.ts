import { readFile } from "node:fs/promises";

import type { ContractValidationResult } from "./contract.js";

export type AnimationOutputFormat = "png_sequence" | "sprite_sheet" | "godot_animation_metadata";
export type AnimationReviewStatus = "draft" | "pending_review" | "approved" | "rejected" | "needs_repair";

export interface AnimationRequestContract {
  readonly character: string;
  readonly animation: string;
  readonly duration: number;
  readonly frame_rate: number;
  readonly camera: string;
  readonly background: string;
  readonly output: readonly AnimationOutputFormat[];
  readonly beats?: readonly string[];
  readonly project_name?: string;
  readonly notes?: string;
}

export interface AnimationFrameReference {
  readonly index: number;
  readonly path: string;
  readonly approval_state?: AnimationReviewStatus;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface AnimationFrameTiming {
  readonly frame: number;
  readonly at_seconds: number;
  readonly duration_seconds: number;
}

export interface AnimationEventMarker {
  readonly name: string;
  readonly frame: number;
  readonly kind?: string;
}

export interface AnimationCollisionSuggestion {
  readonly frame: number;
  readonly shape: "rectangle" | "circle" | "polygon";
  readonly bounds: Readonly<Record<string, number | readonly number[]>>;
}

export interface AnimationResponseContract {
  readonly approved_frame_sequence: readonly AnimationFrameReference[];
  readonly sprite_sheet?: string;
  readonly frame_timings: readonly AnimationFrameTiming[];
  readonly event_markers: readonly AnimationEventMarker[];
  readonly collision_suggestions: readonly AnimationCollisionSuggestion[];
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly review_status: AnimationReviewStatus;
}

export interface AnimationContractValidationResult extends ContractValidationResult {
  readonly contract?: AnimationRequestContract;
}

const OUTPUT_FORMATS = new Set<AnimationOutputFormat>([
  "png_sequence",
  "sprite_sheet",
  "godot_animation_metadata",
]);

const REVIEW_STATUSES = new Set<AnimationReviewStatus>([
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "needs_repair",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function normalizeNamed(value: unknown, path: string, errors: string[]): string | undefined {
  if (nonEmptyString(value)) return value.trim();
  if (isRecord(value) && nonEmptyString(value.name)) return value.name.trim();
  errors.push(`${path} is required and must be a non-empty string or object with a non-empty name`);
  return undefined;
}

function normalizeStringArray(value: unknown, path: string, errors: string[], required: boolean): string[] | undefined {
  if (value === undefined) {
    if (required) errors.push(`${path} is required`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  if (required && value.length === 0) errors.push(`${path} must contain at least one item`);
  const normalized: string[] = [];
  value.forEach((item, index) => {
    if (nonEmptyString(item)) {
      normalized.push(item.trim());
    } else {
      errors.push(`${path}[${index}] must be a non-empty string`);
    }
  });
  return normalized;
}

function outputFormats(value: Record<string, unknown>, errors: string[]): AnimationOutputFormat[] {
  const raw = value.output ?? value.output_formats;
  const list = isRecord(raw) ? raw.formats : raw;
  if (!Array.isArray(list)) {
    errors.push("output must be an array of formats, or an object with a formats array");
    return [];
  }
  if (list.length === 0) errors.push("output must contain at least one format");
  const formats: AnimationOutputFormat[] = [];
  list.forEach((format, index) => {
    if (typeof format !== "string" || !OUTPUT_FORMATS.has(format as AnimationOutputFormat)) {
      errors.push(`output[${index}] must be one of: ${[...OUTPUT_FORMATS].join(", ")}`);
      return;
    }
    formats.push(format as AnimationOutputFormat);
  });
  return formats;
}

function animationBeats(value: Record<string, unknown>, errors: string[]): string[] | undefined {
  const direct = normalizeStringArray(value.beats, "beats", errors, false);
  if (direct !== undefined) return direct;
  const animation = value.animation;
  if (isRecord(animation)) return normalizeStringArray(animation.beats, "animation.beats", errors, false);
  return undefined;
}

export function validateAnimationRequestContract(value: unknown): AnimationContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["animation contract must be a JSON object"] };

  const character = normalizeNamed(value.character, "character", errors);
  const animation = normalizeNamed(value.animation, "animation", errors);
  if (!finitePositiveNumber(value.duration)) errors.push("duration is required and must be a positive number");
  if (!positiveInteger(value.frame_rate)) errors.push("frame_rate is required and must be a positive integer");
  if (!nonEmptyString(value.camera)) errors.push("camera is required and must be a non-empty string");
  if (!nonEmptyString(value.background)) errors.push("background is required and must be a non-empty string");
  if (value.project_name !== undefined && !nonEmptyString(value.project_name)) {
    errors.push("project_name must be a non-empty string when present");
  }
  if (value.notes !== undefined && !nonEmptyString(value.notes)) {
    errors.push("notes must be a non-empty string when present");
  }
  const output = outputFormats(value, errors);
  const beats = animationBeats(value, errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    contract: {
      character: character as string,
      animation: animation as string,
      duration: value.duration as number,
      frame_rate: value.frame_rate as number,
      camera: (value.camera as string).trim(),
      background: (value.background as string).trim(),
      output,
      ...(beats !== undefined ? { beats } : {}),
      ...(nonEmptyString(value.project_name) ? { project_name: value.project_name.trim() } : {}),
      ...(nonEmptyString(value.notes) ? { notes: value.notes.trim() } : {}),
    },
  };
}

export function validateAnimationResponseContract(value: unknown): ContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["animation response must be a JSON object"] };
  if (!Array.isArray(value.approved_frame_sequence)) errors.push("approved_frame_sequence is required and must be an array");
  if (!Array.isArray(value.frame_timings)) errors.push("frame_timings is required and must be an array");
  if (!Array.isArray(value.event_markers)) errors.push("event_markers is required and must be an array");
  if (!Array.isArray(value.collision_suggestions)) errors.push("collision_suggestions is required and must be an array");
  if (!isRecord(value.provenance)) errors.push("provenance is required and must be an object");
  if (typeof value.review_status !== "string" || !REVIEW_STATUSES.has(value.review_status as AnimationReviewStatus)) {
    errors.push(`review_status must be one of: ${[...REVIEW_STATUSES].join(", ")}`);
  }
  if (value.sprite_sheet !== undefined && !nonEmptyString(value.sprite_sheet)) {
    errors.push("sprite_sheet must be a non-empty string when present");
  }
  return { valid: errors.length === 0, errors };
}

export async function readAndValidateAnimationRequestContract(filePath: string): Promise<AnimationContractValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf-8"));
  } catch (e) {
    return { valid: false, errors: [`failed to read or parse JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return validateAnimationRequestContract(parsed);
}
