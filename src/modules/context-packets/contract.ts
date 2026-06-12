/**
 * ikbi context-packets — TASK CONTRACT (the governed task description + validator).
 *
 * A TaskContract is the bounded, validated description of ONE task: its goal, the
 * files a worker is ALLOWED to touch, the files it is FORBIDDEN to touch, and the
 * verification commands that determine truth. `validateTaskContract` is the gate —
 * it rejects unsafe paths (absolute, `..` traversal), duplicates, empty strings, and
 * bad prompt-quality labels, returning structured errors rather than throwing. The
 * context packet is built FROM a validated contract so a model never sees an
 * unbounded task.
 *
 * Ported from scintilla/src/core/contracts/{types,validator}.ts. Adapted for ikbi's
 * `exactOptionalPropertyTypes` (optional fields are omitted, never set to undefined).
 */

import path from "node:path";

export type TaskContractPromptQuality = "P0" | "P1" | "P2" | "P3" | "P4";

export interface TaskContract {
  readonly id?: string;
  readonly benchmarkId?: string;
  readonly taskType: string;
  readonly promptQuality?: TaskContractPromptQuality;
  readonly goal: string;
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly verificationRequired?: readonly string[];
}

export interface TaskContractValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type TaskContractValidationResult =
  | {
      readonly ok: true;
      readonly contract: TaskContract;
    }
  | {
      readonly ok: false;
      readonly errors: readonly TaskContractValidationError[];
    };

const promptQualities = new Set<TaskContractPromptQuality>(["P0", "P1", "P2", "P3", "P4"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTraversal(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes("..");
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !hasTraversal(value);
}

function validateString(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      path: fieldPath,
      code: "invalid_string",
      message: `${fieldPath} must be a non-empty string`
    });
    return false;
  }

  return true;
}

function validateStringArray(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string[] {
  if (!Array.isArray(value)) {
    errors.push({
      path: fieldPath,
      code: "invalid_array",
      message: `${fieldPath} must be an array of strings`
    });
    return false;
  }

  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "invalid_string",
        message: `${fieldPath}[${index}] must be a non-empty string`
      });
    }
  });

  return value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function validatePathArray(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string[] {
  if (!validateStringArray(value, fieldPath, errors)) {
    return false;
  }

  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isSafeRelativePath(entry)) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "unsafe_path",
        message: `${fieldPath}[${index}] must be a safe relative path without traversal`
      });
    }

    if (seen.has(entry)) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "duplicate_path",
        message: `${fieldPath}[${index}] duplicates another path`
      });
    }
    seen.add(entry);
  });

  return value.every(isSafeRelativePath);
}

export function validateTaskContract(contract: unknown): TaskContractValidationResult {
  const errors: TaskContractValidationError[] = [];

  if (!isPlainObject(contract)) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "invalid_contract",
          message: "TaskContract must be an object"
        }
      ]
    };
  }

  if (contract.id !== undefined) {
    validateString(contract.id, "$.id", errors);
  }

  if (contract.benchmarkId !== undefined) {
    validateString(contract.benchmarkId, "$.benchmarkId", errors);
  }

  validateString(contract.taskType, "$.taskType", errors);
  validateString(contract.goal, "$.goal", errors);
  validatePathArray(contract.allowedFiles, "$.allowedFiles", errors);

  if (contract.promptQuality !== undefined && (typeof contract.promptQuality !== "string" || !promptQualities.has(contract.promptQuality as TaskContractPromptQuality))) {
    errors.push({
      path: "$.promptQuality",
      code: "invalid_prompt_quality",
      message: "$.promptQuality must be one of P0, P1, P2, P3, P4"
    });
  }

  if (contract.forbiddenFiles !== undefined) {
    validatePathArray(contract.forbiddenFiles, "$.forbiddenFiles", errors);
  }

  if (contract.verificationRequired !== undefined) {
    validateStringArray(contract.verificationRequired, "$.verificationRequired", errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    };
  }

  // exactOptionalPropertyTypes: omit absent optionals entirely (never `: undefined`).
  return {
    ok: true,
    contract: {
      ...(contract.id !== undefined ? { id: contract.id as string } : {}),
      ...(contract.benchmarkId !== undefined ? { benchmarkId: contract.benchmarkId as string } : {}),
      taskType: contract.taskType as string,
      ...(contract.promptQuality !== undefined ? { promptQuality: contract.promptQuality as TaskContractPromptQuality } : {}),
      goal: contract.goal as string,
      allowedFiles: [...(contract.allowedFiles as string[])],
      ...(contract.forbiddenFiles !== undefined ? { forbiddenFiles: [...(contract.forbiddenFiles as string[])] } : {}),
      ...(contract.verificationRequired !== undefined ? { verificationRequired: [...(contract.verificationRequired as string[])] } : {})
    }
  };
}
