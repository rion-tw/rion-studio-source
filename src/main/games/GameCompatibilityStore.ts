import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  GameCompatibilityObservations,
  GameCompatibilityReport
} from "../../shared/types";
import { SerialTaskQueue } from "../persistence/SerialTaskQueue";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";
import type { StateRepository } from "../core/RustStateRepository";

interface CompatibilityFile {
  reports: GameCompatibilityReport[];
}

export class GameCompatibilityStore {
  private cachedFile: CompatibilityFile | undefined;
  private readonly filePath: string;
  private readonly taskQueue = new SerialTaskQueue();

  constructor(userDataDir: string, private readonly stateRepository?: StateRepository) {
    this.filePath = join(userDataDir, "game-compatibility.json");
  }

  async listReports(): Promise<GameCompatibilityReport[]> {
    return this.taskQueue.run(async () => structuredClone((await this.readFile()).reports));
  }

  async saveReport(report: GameCompatibilityReport): Promise<GameCompatibilityReport> {
    return this.taskQueue.run(async () => {
      const file = await this.readFile();
      const index = file.reports.findIndex((item) => item.gameId === report.gameId);
      const current = index === -1 ? undefined : file.reports[index];
      const next: GameCompatibilityReport = {
        ...structuredClone(report),
        observations: {
          ...(current?.observations ?? {}),
          ...report.observations
        }
      };
      next.observations = sanitizeObservations(next.observations);
      if (index === -1) {
        file.reports.push(next);
      } else {
        file.reports[index] = next;
      }
      await this.writeFile(file);
      return structuredClone(next);
    });
  }

  async recordObservation(
    gameId: string,
    observation: Partial<GameCompatibilityObservations>
  ): Promise<GameCompatibilityReport> {
    return this.taskQueue.run(async () => {
      const file = await this.readFile();
      const index = file.reports.findIndex((item) => item.gameId === gameId);
      const current = index === -1
        ? { gameId, isStale: false, observations: {} }
        : file.reports[index];
      const next: GameCompatibilityReport = {
        ...current,
        observations: sanitizeObservations({ ...current.observations, ...observation })
      };
      if (index === -1) {
        file.reports.push(next);
      } else {
        file.reports[index] = next;
      }
      await this.writeFile(file);
      return structuredClone(next);
    });
  }

  async deleteGame(gameId: string): Promise<void> {
    return this.taskQueue.run(async () => {
      const file = await this.readFile();
      const reports = file.reports.filter((report) => report.gameId !== gameId);
      if (reports.length !== file.reports.length) {
        await this.writeFile({ reports });
      }
    });
  }

  private async readFile(): Promise<CompatibilityFile> {
    if (this.cachedFile) {
      return structuredClone(this.cachedFile);
    }
    try {
      const parsed = this.stateRepository
        ? { reports: await this.stateRepository.read("compatibilityReports", []) }
        : JSON.parse(await readFile(this.filePath, "utf8")) as { reports?: unknown };
      const reports = Array.isArray(parsed.reports)
        ? parsed.reports.filter(isCompatibilityReport).map((report) => ({
            ...report,
            isStale: false,
            observations: sanitizeObservations(report.observations)
          }))
        : [];
      this.cachedFile = { reports };
      if (JSON.stringify(parsed.reports) !== JSON.stringify(reports)) {
        await this.writeFile(this.cachedFile);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.cachedFile = { reports: [] };
      } else {
        this.cachedFile = { reports: [] };
      }
    }
    return structuredClone(this.cachedFile);
  }

  private async writeFile(file: CompatibilityFile): Promise<void> {
    if (this.stateRepository) {
      await this.stateRepository.replace("compatibilityReports", file.reports);
    } else {
      await writeJsonFileAtomically(this.filePath, file);
    }
    this.cachedFile = structuredClone(file);
  }
}

function sanitizeObservations(observations: GameCompatibilityObservations): GameCompatibilityObservations {
  const {
    lastAuthSuccessAt: _lastAuthSuccessAt,
    lastAuthFailureAt: _lastAuthFailureAt,
    ...clean
  } = observations as GameCompatibilityObservations & {
    lastAuthSuccessAt?: unknown;
    lastAuthFailureAt?: unknown;
  };
  return clean;
}

function isCompatibilityReport(value: unknown): value is GameCompatibilityReport {
  return isRecord(value) && typeof value.gameId === "string" && isRecord(value.observations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
