import { readFile } from "node:fs/promises";

import type { ContractValidationResult, GameFeatureContract } from "./contract.js";

export const GAME_FEATURE_CONTRACT_SCHEMA = {
  type: "object",
  required: ["id", "player_experience", "godot_requirements", "acceptance_tests"],
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    player_experience: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    godot_requirements: {
      type: "object",
      properties: {
        scene_type: { type: "string", minLength: 1 },
        signals: { type: "array", items: { type: "string", minLength: 1 } },
        persistence_key: { type: "string", minLength: 1 },
        required_assets: { type: "array", items: { type: "string", minLength: 1 } },
        input_actions: { type: "array", items: { type: "string", minLength: 1 } },
        scripts: { type: "array", items: { type: "string", minLength: 1 } },
      },
      additionalProperties: false,
    },
    acceptance_tests: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "steps", "expected"],
        properties: {
          name: { type: "string", minLength: 1 },
          steps: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          expected: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && !nonEmptyString(value)) errors.push(`${path} must be a non-empty string when present`);
}

function stringArray(value: unknown, path: string, errors: string[], required: boolean): void {
  if (value === undefined) {
    if (required) errors.push(`${path} is required`);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (required && value.length === 0) errors.push(`${path} must contain at least one item`);
  value.forEach((item, index) => {
    if (!nonEmptyString(item)) errors.push(`${path}[${index}] must be a non-empty string`);
  });
}

function rejectUnknownKeys(value: Record<string, unknown>, path: string, allowed: readonly string[], errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

export function validateGameFeatureContract(value: unknown): ContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["contract must be a JSON object"] };

  rejectUnknownKeys(value, "contract", ["id", "title", "player_experience", "godot_requirements", "acceptance_tests"], errors);
  if (!nonEmptyString(value.id)) errors.push("id is required and must be a non-empty string");
  optionalString(value.title, "title", errors);
  stringArray(value.player_experience, "player_experience", errors, true);

  if (!isRecord(value.godot_requirements)) {
    errors.push("godot_requirements is required and must be an object");
  } else {
    rejectUnknownKeys(
      value.godot_requirements,
      "godot_requirements",
      ["scene_type", "signals", "persistence_key", "required_assets", "input_actions", "scripts"],
      errors,
    );
    optionalString(value.godot_requirements.scene_type, "godot_requirements.scene_type", errors);
    optionalString(value.godot_requirements.persistence_key, "godot_requirements.persistence_key", errors);
    stringArray(value.godot_requirements.signals, "godot_requirements.signals", errors, false);
    stringArray(value.godot_requirements.required_assets, "godot_requirements.required_assets", errors, false);
    stringArray(value.godot_requirements.input_actions, "godot_requirements.input_actions", errors, false);
    stringArray(value.godot_requirements.scripts, "godot_requirements.scripts", errors, false);
  }

  if (!Array.isArray(value.acceptance_tests)) {
    errors.push("acceptance_tests is required and must be an array");
  } else {
    if (value.acceptance_tests.length === 0) errors.push("acceptance_tests must contain at least one item");
    value.acceptance_tests.forEach((item, index) => {
      const path = `acceptance_tests[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${path} must be an object`);
        return;
      }
      rejectUnknownKeys(item, path, ["name", "steps", "expected"], errors);
      if (!nonEmptyString(item.name)) errors.push(`${path}.name is required and must be a non-empty string`);
      stringArray(item.steps, `${path}.steps`, errors, true);
      if (!nonEmptyString(item.expected)) errors.push(`${path}.expected is required and must be a non-empty string`);
    });
  }

  return { valid: errors.length === 0, errors };
}

export async function readAndValidateGameFeatureContract(filePath: string): Promise<ContractValidationResult & { readonly contract?: GameFeatureContract }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf-8"));
  } catch (e) {
    return { valid: false, errors: [`failed to read or parse JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const result = validateGameFeatureContract(parsed);
  return result.valid ? { ...result, contract: parsed as GameFeatureContract } : result;
}
