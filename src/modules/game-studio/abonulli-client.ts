import type { AnimationOutputFormat, AnimationRequestContract } from "./animation-contracts.js";

export interface AbonulliClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface AbonulliHealth {
  readonly status: string;
}

export interface AbonulliProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string | null;
  readonly status?: string;
}

export interface AbonulliSequence {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly fps: number;
  readonly approval_state?: string;
}

export interface AbonulliShot {
  readonly id: string;
  readonly project_id: string;
  readonly sequence_id: string;
  readonly name: string;
  readonly order_index: number;
  readonly frame_range: { readonly start_frame: number; readonly end_frame: number };
  readonly approval_state?: string;
}

export interface AbonulliBeat {
  readonly id: string;
  readonly project_id: string;
  readonly shot_id: string;
  readonly order_index: number;
  readonly description: string;
}

export interface AbonulliExportArtifact {
  readonly id: string;
  readonly project_id: string;
  readonly preset_id: string;
  readonly path: string;
  readonly format: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly approval_state?: string;
}

export interface AbonulliExportRequestResult {
  readonly format: AnimationOutputFormat;
  readonly artifacts: readonly AbonulliExportArtifact[];
  readonly error?: string;
}

export interface AbonulliAnimationJob {
  readonly project: AbonulliProject;
  readonly sequence: AbonulliSequence;
  readonly shot: AbonulliShot;
  readonly beats: readonly AbonulliBeat[];
  readonly exports: readonly AbonulliExportRequestResult[];
}

export type AbonulliExportStatus =
  | { readonly status: "succeeded"; readonly artifacts: readonly AbonulliExportArtifact[] }
  | { readonly status: "pending"; readonly artifacts: readonly AbonulliExportArtifact[] };

export class AbonulliHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Abonulli HTTP ${status}${body.length > 0 ? `: ${body}` : ""}`);
    this.name = "AbonulliHttpError";
    this.status = status;
    this.body = body;
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 72) : "animation-request";
}

function formatForAbonulli(format: AnimationOutputFormat): string {
  if (format === "godot_animation_metadata") return "godot_manifest";
  return format;
}

function defaultBeats(contract: AnimationRequestContract): string[] {
  if (contract.beats !== undefined && contract.beats.length > 0) return [...contract.beats];
  return [
    `${contract.character} starts ${contract.animation}.`,
    `${contract.character} completes ${contract.animation}.`,
  ];
}

async function responseText(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

export class AbonulliClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AbonulliClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<AbonulliHealth> {
    return this.requestJson<AbonulliHealth>("GET", "/health");
  }

  async createProject(input: { readonly name: string; readonly slug?: string; readonly description?: string }): Promise<AbonulliProject> {
    return this.requestJson<AbonulliProject>("POST", "/api/projects", {
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  }

  async createSequence(
    projectId: string,
    input: { readonly name: string; readonly description?: string; readonly fps: number },
  ): Promise<AbonulliSequence> {
    return this.requestJson<AbonulliSequence>("POST", `/api/projects/${projectId}/sequences`, {
      name: input.name,
      fps: input.fps,
      approval_state: "pending_review",
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  }

  async createShot(
    projectId: string,
    input: { readonly sequenceId: string; readonly name: string; readonly startFrame: number; readonly endFrame: number },
  ): Promise<AbonulliShot> {
    return this.requestJson<AbonulliShot>("POST", `/api/projects/${projectId}/shots`, {
      sequence_id: input.sequenceId,
      name: input.name,
      order_index: 0,
      frame_range: {
        start_frame: input.startFrame,
        end_frame: input.endFrame,
      },
      approval_state: "pending_review",
    });
  }

  async createBeat(
    projectId: string,
    input: { readonly shotId: string; readonly orderIndex: number; readonly description: string },
  ): Promise<AbonulliBeat> {
    return this.requestJson<AbonulliBeat>("POST", `/api/projects/${projectId}/beats`, {
      shot_id: input.shotId,
      order_index: input.orderIndex,
      description: input.description,
    });
  }

  async requestExport(
    projectId: string,
    sequenceId: string,
    input: { readonly name: string; readonly format: AnimationOutputFormat; readonly settings?: Readonly<Record<string, unknown>> },
  ): Promise<AbonulliExportArtifact[]> {
    return this.requestJson<AbonulliExportArtifact[]>("POST", `/api/projects/${projectId}/sequences/${sequenceId}/exports`, {
      name: input.name,
      format: formatForAbonulli(input.format),
      settings: input.settings ?? {},
    });
  }

  async pollExportStatus(
    projectId: string,
    expectedFormats: readonly AnimationOutputFormat[],
  ): Promise<AbonulliExportStatus> {
    const artifacts = await this.requestJson<AbonulliExportArtifact[]>("GET", `/api/projects/${projectId}/exports`);
    const expected = new Set(expectedFormats.map(formatForAbonulli));
    const seen = new Set(artifacts.map((artifact) => artifact.format));
    const complete = [...expected].every((format) => seen.has(format));
    return { status: complete ? "succeeded" : "pending", artifacts };
  }

  async requestAnimation(contract: AnimationRequestContract): Promise<AbonulliAnimationJob> {
    const projectName = contract.project_name ?? `${contract.character} ${contract.animation}`;
    const description = JSON.stringify({
      source: "ikbi.game-studio.animation-contract",
      character: contract.character,
      animation: contract.animation,
      duration: contract.duration,
      frame_rate: contract.frame_rate,
      camera: contract.camera,
      background: contract.background,
      notes: contract.notes,
    });
    const project = await this.createProject({ name: projectName, description });
    const sequence = await this.createSequence(project.id, {
      name: contract.animation,
      description,
      fps: contract.frame_rate,
    });
    const frameCount = Math.max(1, Math.ceil(contract.duration * contract.frame_rate));
    const shot = await this.createShot(project.id, {
      sequenceId: sequence.id,
      name: contract.animation,
      startFrame: 0,
      endFrame: frameCount - 1,
    });
    const beats = await Promise.all(defaultBeats(contract).map((beat, index) => this.createBeat(project.id, {
      shotId: shot.id,
      orderIndex: index,
      description: beat,
    })));
    const exports: AbonulliExportRequestResult[] = [];
    for (const format of contract.output) {
      try {
        exports.push({
          format,
          artifacts: await this.requestExport(project.id, sequence.id, {
            name: `${contract.animation} ${format}`,
            format,
            settings: { fps: contract.frame_rate },
          }),
        });
      } catch (e) {
        exports.push({
          format,
          artifacts: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { project, sequence, shot, beats, exports };
  }

  private async requestJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      if (!response.ok) throw new AbonulliHttpError(response.status, await responseText(response));
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
