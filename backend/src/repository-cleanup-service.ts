
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CHANGE: RepositoryCleanupService now supports resumable execution and avoids false positives by verifying repository availability without mutating datasets.
// WHY: GitHub API may return transient 403/451 responses; caching ensures long runs can resume and only confirmed missing repositories are reported.
// QUOTE(TЗ): "А как мы можем сделать что бы мы не запсиывали в список репозитории которые не удалены?"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

type GitHubRepositoryName = `${string}/${string}`;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type RepositoryDatasetName =
  | "oxide_plugins"
  | "crawled_plugins"
  | "author_discovered"
  | "manual_repositories"
  | "author_finder_state"
  | "crawler_state"
  | "indexer_state";

interface RepoInfo {
  readonly full_name?: GitHubRepositoryName;
  readonly name?: string;
  readonly html_url?: string;
  readonly description?: string | null;
  readonly owner_login?: string;
  readonly owner_url?: string;
  readonly default_branch?: string;
  readonly stargazers_count?: number;
  readonly forks_count?: number;
  readonly open_issues_count?: number;
}

interface OxidePluginEntry {
  readonly plugin_name: string;
  readonly language: string;
  readonly repository?: RepoInfo;
}

interface OxidePluginData {
  generated_at: string;
  query: string;
  count: number;
  items: OxidePluginEntry[];
}

interface CrawledPluginEntry {
  readonly plugin_name: string;
  readonly language: string;
  readonly repository?: RepoInfo;
}

interface CrawledPluginData {
  generated_at: string;
  query: string;
  count: number;
  items: CrawledPluginEntry[];
}

interface AuthorDiscoveredRepositories {
  generated_at: string;
  source: string;
  count: number;
  repositories: GitHubRepositoryName[];
}

interface AuthorFinderState {
  last_updated: string;
  current_author_index: number;
  processed_authors: Record<
    string,
    {
      last_processed: string;
      repositories_found: number;
      success: boolean;
      error?: string;
    }
  >;
  discovered_repositories: GitHubRepositoryName[];
}

interface CrawlerState {
  last_updated: string;
  total_repositories_processed: number;
  successful_crawls: number;
  failed_crawls: number;
  processed_repositories: Record<
    string,
    {
      last_crawled: string;
      plugins_count: number;
      success: boolean;
      errors: string[];
    }
  >;
}

interface IndexerState {
  version: string;
  currentVariant: number;
  currentPage: number;
  seenKeys: Record<string, boolean>;
}

interface RepositoryCleanupConfig {
  readonly inputDir?: string;
  readonly outputDir?: string;
  readonly githubToken?: string;
  readonly concurrencyLimit?: number;
  readonly interRequestDelayMs?: number;
  readonly githubApiBaseUrl?: string;
}

interface RepositoryCleanupDependencies {
  readonly fetchFn?: FetchLike;
  readonly now?: () => Date;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly log?: (dataset: RepositoryDatasetName, message: string) => void;
}

interface RepositoryUsage {
  occurrences: number;
  datasets: Partial<Record<RepositoryDatasetName, number>>;
}

interface RepositoryCheckResult {
  readonly repo: GitHubRepositoryName;
  readonly status: "exists" | "missing" | "error";
  readonly httpStatus?: number;
  readonly message?: string;
}

export interface RepositoryCleanupReport {
  readonly scannedRepositories: number;
  readonly missingRepositories: GitHubRepositoryName[];
  readonly updatedFiles: string[];
  readonly errors: RepositoryCheckResult[];
  readonly datasetImpacts: Record<RepositoryDatasetName, number>;
}

interface DatasetBundle {
  readonly oxidePlugins: DatasetWithPath<OxidePluginData>;
  readonly crawledPlugins: DatasetWithPath<CrawledPluginData>;
  readonly authorDiscovered: DatasetWithPath<AuthorDiscoveredRepositories>;
  readonly authorFinderState: DatasetWithPath<AuthorFinderState>;
  readonly crawlerState: DatasetWithPath<CrawlerState>;
  readonly indexerState: DatasetWithPath<IndexerState>;
  readonly manualRepositories: DatasetWithPath<string[]>;
}

interface DatasetWithPath<TData> {
  readonly path: string;
  data: TData | null;
}

interface CleanupProcessingRecord extends RepositoryCheckResult {
  readonly checkedAt: string;
}

interface CleanupState {
  version: string;
  createdAt: string;
  updatedAt: string;
  repositories: GitHubRepositoryName[];
  processed: Record<GitHubRepositoryName, CleanupProcessingRecord>;
  missing: GitHubRepositoryName[];
  errors: Record<GitHubRepositoryName, RepositoryCheckResult>;
  nextIndex: number;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DELAY_MS = 0;
const DEFAULT_GITHUB_API_BASE = "https://api.github.com/repos/";
const DEFAULT_NOW: () => Date = () => new Date();
const CLEANUP_STATE_VERSION = "1";
const HTML_REPO_BASE_URL = "https://github.com/";

/**
 * @public
 * @remarks
 * Ensures exported backend datasets remain consistent with GitHub by recording only confirmed missing repositories.
 * @invariant Output JSON files remain unchanged unless a repository is verifiably absent.
 */
export class RepositoryCleanupService {
  private readonly paths: Record<
    "oxidePlugins" | "crawledPlugins" | "authorDiscovered" | "authorFinderState" | "crawlerState" | "indexerState" | "manualRepositories" | "deletedRepositoriesReport" | "cleanupState",
    string
  >;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly log: (dataset: RepositoryDatasetName, message: string) => void;
  private readonly concurrencyLimit: number;
  private readonly delayMs: number;
  private readonly githubToken: string | undefined;
  private readonly githubApiBaseUrl: string;

  public constructor(
    private readonly config: RepositoryCleanupConfig,
    dependencies: RepositoryCleanupDependencies = {}
  ) {
    const outputDir = path.resolve(config.outputDir ?? path.join(process.cwd(), "output"));
    const inputDir = path.resolve(config.inputDir ?? path.join(process.cwd(), "input"));

    this.paths = {
      oxidePlugins: path.join(outputDir, "oxide_plugins.json"),
      crawledPlugins: path.join(outputDir, "crawled_plugins.json"),
      authorDiscovered: path.join(outputDir, "author_discovered_repositories.json"),
      authorFinderState: path.join(outputDir, "author_finder_state.json"),
      crawlerState: path.join(outputDir, "crawler_state.json"),
      indexerState: path.join(outputDir, "state.json"),
      manualRepositories: path.join(inputDir, "manual-repositories.json"),
      deletedRepositoriesReport: path.join(outputDir, "deleted_repositories.json"),
      cleanupState: path.join(outputDir, "cleanup_state.json"),
    };

    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.now = dependencies.now ?? DEFAULT_NOW;
    this.sleepFn = dependencies.sleepFn ?? (async (ms): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    this.log = dependencies.log ?? ((dataset, message): void => {
      console.log(`[cleanup:${dataset}] ${message}`);
    });
    this.concurrencyLimit = Math.max(1, config.concurrencyLimit ?? DEFAULT_CONCURRENCY);
    this.delayMs = Math.max(0, config.interRequestDelayMs ?? DEFAULT_DELAY_MS);
    this.githubToken = config.githubToken;
    this.githubApiBaseUrl = config.githubApiBaseUrl ?? DEFAULT_GITHUB_API_BASE;
  }

  public async run(): Promise<RepositoryCleanupReport> {
    const datasets = await this.loadDatasets();
    const usageMap = this.collectRepositoryUsage(datasets);
    const repositories = Array.from(usageMap.keys()).sort();

    // CHANGE: Emit detailed trace for the overall workload to improve observability during manual runs.
    // WHY: User requested "Добавь больше логов" after seeing only the final summary.
    // QUOTE(TЗ): "Добавь больше логов"
    // REF: REQ-REMOTE-CLEANUP-001
    // SOURCE: internal-analysis
    this.log("indexer_state", `Starting verification of ${repositories.length} repositories.`);

    if (repositories.length === 0) {
      return {
        scannedRepositories: 0,
        missingRepositories: [],
        updatedFiles: [],
        errors: [],
        datasetImpacts: this.buildEmptyImpacts(),
      };
    }

    const state = await this.loadOrInitializeState(repositories);
    const processedBefore = state.nextIndex;
    const { rateLimitHit } = await this.processRepositories(state);

    if (!rateLimitHit && state.nextIndex >= state.repositories.length) {
      const missingSorted = [...new Set(state.missing)].sort();
      await this.writeDeletedReport(missingSorted);
      await this.deleteState();
      return {
        scannedRepositories: state.repositories.length,
        missingRepositories: missingSorted,
        updatedFiles: missingSorted.length > 0 ? [this.paths.deletedRepositoriesReport] : [],
        errors: Object.values(state.errors),
        datasetImpacts: this.buildEmptyImpacts(),
      };
    }

    // Persist partial progress; next run will resume from this state.
    await this.writeState(state);
    return {
      scannedRepositories: processedBefore + (state.nextIndex - processedBefore),
      missingRepositories: [...new Set(state.missing)].sort(),
      updatedFiles: [],
      errors: Object.values(state.errors),
      datasetImpacts: this.buildEmptyImpacts(),
    };
  }

  private buildEmptyImpacts(): Record<RepositoryDatasetName, number> {
    return {
      oxide_plugins: 0,
      crawled_plugins: 0,
      author_discovered: 0,
      manual_repositories: 0,
      author_finder_state: 0,
      crawler_state: 0,
      indexer_state: 0,
    };
  }

  private async processRepositories(state: CleanupState): Promise<{ rateLimitHit: boolean }> {
    for (let index = state.nextIndex; index < state.repositories.length; index += 1) {
      const repo = state.repositories[index];
      if (!repo) {
        continue;
      }
      const result = await this.checkSingleRepository(repo);

      if (this.isRateLimitResult(result)) {
        const nowIso = this.now().toISOString();
        state.errors[repo] = result;
        state.updatedAt = nowIso;
        state.nextIndex = index;
        await this.writeState(state);
        this.log("indexer_state", `Rate limit hit after processing ${state.nextIndex} repositories.`);
        return { rateLimitHit: true };
      }

      this.updateStateWithResult(state, repo, result);
      state.nextIndex = index + 1;
      await this.writeState(state);

      if (this.delayMs > 0 && index + 1 < state.repositories.length) {
        await this.sleepFn(this.delayMs);
      }
    }

    return { rateLimitHit: false };
  }

  private updateStateWithResult(state: CleanupState, repo: GitHubRepositoryName, result: RepositoryCheckResult): void {
    const checkedAt = this.now().toISOString();
    state.processed[repo] = { ...result, checkedAt };
    state.updatedAt = checkedAt;

    const missingSet = new Set(state.missing);
    if (result.status === "missing") {
      missingSet.add(repo);
    } else {
      missingSet.delete(repo);
    }
    state.missing = Array.from(missingSet);

    if (result.status === "error") {
      state.errors[repo] = result;
    } else {
      delete state.errors[repo];
    }
  }

  private async loadOrInitializeState(repositories: GitHubRepositoryName[]): Promise<CleanupState> {
    const sorted = [...new Set(repositories)].sort();
    const existing = await this.readState();

    if (!existing) {
      const nowIso = this.now().toISOString();
      const state: CleanupState = {
        version: CLEANUP_STATE_VERSION,
        createdAt: nowIso,
        updatedAt: nowIso,
        repositories: sorted,
        processed: {},
        missing: [],
        errors: {},
        nextIndex: 0,
      };
      await this.writeState(state);
      return state;
    }

    const repositorySet = new Set(sorted);
    const processed: Record<GitHubRepositoryName, CleanupProcessingRecord> = {};
    for (const [repo, record] of Object.entries(existing.processed)) {
      if (repositorySet.has(repo as GitHubRepositoryName)) {
        processed[repo as GitHubRepositoryName] = record;
      }
    }

    const missing = existing.missing.filter((repo) => repositorySet.has(repo));

    const errors: Record<GitHubRepositoryName, RepositoryCheckResult> = {};
    for (const [repo, record] of Object.entries(existing.errors)) {
      if (repositorySet.has(repo as GitHubRepositoryName)) {
        errors[repo as GitHubRepositoryName] = record;
      }
    }

    let nextIndex = 0;
    while (nextIndex < sorted.length) {
      const repo = sorted[nextIndex];
      if (!repo || !processed[repo]) {
        break;
      }
      nextIndex += 1;
    }

    const state: CleanupState = {
      version: CLEANUP_STATE_VERSION,
      createdAt: existing.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      repositories: sorted,
      processed,
      missing,
      errors,
      nextIndex,
    };
    await this.writeState(state);
    return state;
  }

  private async readState(): Promise<CleanupState | null> {
    try {
      const raw = await fs.readFile(this.paths.cleanupState, "utf-8");
      const parsed = JSON.parse(raw) as CleanupState & { version?: string };
      if (parsed.version !== CLEANUP_STATE_VERSION) {
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeState(state: CleanupState): Promise<void> {
    const payload = {
      ...state,
      missing: [...new Set(state.missing)].sort(),
    } satisfies CleanupState;
    await this.writeJson(this.paths.cleanupState, payload);
  }

  private async deleteState(): Promise<void> {
    try {
      await fs.unlink(this.paths.cleanupState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async loadDatasets(): Promise<DatasetBundle> {
    return {
      oxidePlugins: {
        path: this.paths.oxidePlugins,
        data: await this.readJson<OxidePluginData>(this.paths.oxidePlugins),
      },
      crawledPlugins: {
        path: this.paths.crawledPlugins,
        data: await this.readJson<CrawledPluginData>(this.paths.crawledPlugins),
      },
      authorDiscovered: {
        path: this.paths.authorDiscovered,
        data: await this.readJson<AuthorDiscoveredRepositories>(this.paths.authorDiscovered),
      },
      authorFinderState: {
        path: this.paths.authorFinderState,
        data: await this.readJson<AuthorFinderState>(this.paths.authorFinderState),
      },
      crawlerState: {
        path: this.paths.crawlerState,
        data: await this.readJson<CrawlerState>(this.paths.crawlerState),
      },
      indexerState: {
        path: this.paths.indexerState,
        data: await this.readJson<IndexerState>(this.paths.indexerState),
      },
      manualRepositories: {
        path: this.paths.manualRepositories,
        data: await this.readJson<string[]>(this.paths.manualRepositories),
      },
    };
  }

  private collectRepositoryUsage(datasets: DatasetBundle): Map<GitHubRepositoryName, RepositoryUsage> {
    const usage = new Map<GitHubRepositoryName, RepositoryUsage>();

    const record = (repo: GitHubRepositoryName, dataset: RepositoryDatasetName): void => {
      const entry = usage.get(repo) ?? { occurrences: 0, datasets: {} };
      entry.occurrences += 1;
      entry.datasets[dataset] = (entry.datasets[dataset] ?? 0) + 1;
      usage.set(repo, entry);
    };

    const oxide = datasets.oxidePlugins.data;
    if (oxide) {
      for (const item of oxide.items) {
        const repoName = item.repository?.full_name;
        if (repoName) {
          record(repoName, "oxide_plugins");
        }
      }
    }

    const crawled = datasets.crawledPlugins.data;
    if (crawled) {
      for (const item of crawled.items) {
        const repoName = item.repository?.full_name;
        if (repoName) {
          record(repoName, "crawled_plugins");
        }
      }
    }

    const discovered = datasets.authorDiscovered.data;
    if (discovered) {
      for (const repoName of discovered.repositories) {
        record(repoName, "author_discovered");
      }
    }

    const manual = datasets.manualRepositories.data;
    if (manual) {
      for (const entry of manual) {
        const repoName = this.parseManualRepository(entry);
        if (repoName) {
          record(repoName, "manual_repositories");
        }
      }
    }

    const authorFinderState = datasets.authorFinderState.data;
    if (authorFinderState) {
      for (const repoName of authorFinderState.discovered_repositories) {
        record(repoName, "author_finder_state");
      }
    }

    const crawlerState = datasets.crawlerState.data;
    if (crawlerState) {
      for (const repoName of Object.keys(crawlerState.processed_repositories)) {
        record(repoName as GitHubRepositoryName, "crawler_state");
      }
    }

    const indexerState = datasets.indexerState.data;
    if (indexerState) {
      for (const seenKey of Object.keys(indexerState.seenKeys)) {
        const repoName = seenKey.split("#", 1)[0] as GitHubRepositoryName;
        record(repoName, "indexer_state");
      }
    }

    return usage;
  }

  private async checkSingleRepository(repo: GitHubRepositoryName): Promise<RepositoryCheckResult> {
    const url = `${this.githubApiBaseUrl}${repo}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "oxide-plugin-cleanup/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (this.githubToken) {
      headers.Authorization = `Bearer ${this.githubToken}`;
    }

    const response = await this.fetchFn(url, { method: "GET", headers });

    if (response.status >= 200 && response.status < 300) {
      return { repo, status: "exists", httpStatus: response.status };
    }

    if (response.status === 404 || response.status === 410 || response.status === 451) {
      return {
        repo,
        status: "missing",
        httpStatus: response.status,
        message: this.describeMissingStatus(response.status),
      };
    }

    if (response.status === 403) {
      const bodyText = await this.safeReadBody(response);
      if (this.isRateLimitResponse(response, bodyText)) {
        return {
          repo,
          status: "error",
          httpStatus: response.status,
          message: bodyText || "GitHub API rate limit exceeded.",
        };
      }

      const htmlProbe = await this.checkHtmlEndpoint(repo);
      if (htmlProbe === "missing") {
        return {
          repo,
          status: "missing",
          httpStatus: response.status,
          message: "Forbidden via API but missing via public endpoint.",
        };
      }
      if (htmlProbe === "exists") {
        return {
          repo,
          status: "exists",
          httpStatus: response.status,
          message: bodyText || "Repository accessible via HTML despite API 403.",
        };
      }

      return {
        repo,
        status: "error",
        httpStatus: response.status,
        message: bodyText || "Forbidden",
      };
    }

    if (response.status >= 500) {
      return {
        repo,
        status: "error",
        httpStatus: response.status,
        message: `GitHub server error (${response.status}).`,
      };
    }

    if (response.ok) {
      return {
        repo,
        status: "exists",
        httpStatus: response.status,
      };
    }

    return {
      repo,
      status: "error",
      httpStatus: response.status,
      message: `Unexpected status ${response.status}.`,
    };
  }

  private async checkHtmlEndpoint(repo: GitHubRepositoryName): Promise<"exists" | "missing" | "unknown"> {
    const url = `${HTML_REPO_BASE_URL}${repo}`;
    try {
      let response = await fetch(url, { method: "HEAD", redirect: "manual" });
      if (response.status === 405) {
        response = await fetch(url, { method: "GET", redirect: "manual" });
      }

      if (response.status >= 200 && response.status < 400) {
        return "exists";
      }
      if (response.status === 404 || response.status === 410 || response.status === 451) {
        return "missing";
      }
      return "unknown";
    } catch (error) {
      this.log("indexer_state", `${repo} html probe failed: ${(error as Error).message}`);
      return "unknown";
    }
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      const clone = response.clone?.() ?? response;
      return await clone.text();
    } catch {
      return "";
    }
  }

  private isRateLimitResponse(response: Response, body: string): boolean {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") {
      return true;
    }
    const normalized = body.toLowerCase();
    return normalized.includes("rate limit") || normalized.includes("abuse detection");
  }

  private isRateLimitResult(result: RepositoryCheckResult): boolean {
    if (result.status !== "error") {
      return false;
    }
    if (result.httpStatus !== 403) {
      return false;
    }
    const message = result.message?.toLowerCase() ?? "";
    return message.includes("rate limit") || message.includes("abuse");
  }

  private describeMissingStatus(status: number): string {
    switch (status) {
      case 403:
        return "Repository forbidden (private or access restricted) — treated as missing.";
      case 404:
        return "Repository not found (deleted or made private).";
      case 410:
        return "Repository gone (410).";
      case 451:
        return "Repository unavailable for legal reasons.";
      default:
        return "Repository unavailable.";
    }
  }

  private async writeDeletedReport(missingRepos: GitHubRepositoryName[]): Promise<void> {
    const payload = {
      generated_at: this.now().toISOString(),
      count: missingRepos.length,
      repositories: missingRepos,
    };
    await this.writeJson(this.paths.deletedRepositoriesReport, payload);
  }

  private parseManualRepository(entry: string): GitHubRepositoryName | null {
    if (!entry) {
      return null;
    }

    const trimmed = entry.trim();

    if (!trimmed) {
      return null;
    }

    if (trimmed.includes("://")) {
      try {
        const url = new URL(trimmed);
        if (!url.hostname.endsWith("github.com")) {
          return null;
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          const owner = segments[0];
          const repoSegment = segments[1];
          if (!owner || !repoSegment) {
            return null;
          }
          const parsedRepo = repoSegment.replace(/\.git$/iu, "");
          return `${owner}/${parsedRepo}`;
        }
      } catch {
        return null;
      }
      return null;
    }

    const parts = trimmed.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }

    return null;
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const folder = path.dirname(filePath);
    await fs.mkdir(folder, { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tempPath, payload, "utf-8");
    await fs.rename(tempPath, filePath);
  }
}

async function runCleanupCli(): Promise<void> {
  const baseConfig: RepositoryCleanupConfig = {
    inputDir: path.join(process.cwd(), "input"),
    outputDir: path.join(process.cwd(), "output"),
  };

  const config: RepositoryCleanupConfig = {
    ...baseConfig,
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    ...(process.env.CLEANUP_CONCURRENCY
      ? { concurrencyLimit: Number.parseInt(process.env.CLEANUP_CONCURRENCY, 10) }
      : {}),
    ...(process.env.CLEANUP_DELAY_MS
      ? { interRequestDelayMs: Number.parseInt(process.env.CLEANUP_DELAY_MS, 10) }
      : {}),
    ...(process.env.CLEANUP_GITHUB_API_BASE
      ? { githubApiBaseUrl: process.env.CLEANUP_GITHUB_API_BASE }
      : {}),
  };

  const service = new RepositoryCleanupService(config, {
    log: (dataset, message): void => {
      console.log(`[cleanup:${dataset}] ${message}`);
    },
  });

  const started = Date.now();
  const report = await service.run();
  const elapsed = Date.now() - started;

  console.log(
    [
      `Scanned: ${report.scannedRepositories}`,
      `Missing: ${report.missingRepositories.length}`,
      `Errors: ${report.errors.length}`,
      `Duration: ${elapsed}ms`,
    ].join(" | ")
  );

  if (report.missingRepositories.length > 0) {
    console.log(
      `Missing repositories written to ${path.relative(
        process.cwd(),
        thisServiceOutputPath("deleted_repositories.json")
      )}`
    );
    // CHANGE: Provide a concise preview of missing repositories to aid manual inspection without opening the JSON file.
    // WHY: User explicitly asked for additional logging around the cleanup results.
    // QUOTE(TЗ): "Добавь больше логов"
    // REF: REQ-REMOTE-CLEANUP-001
    // SOURCE: internal-analysis
    const preview = report.missingRepositories.slice(0, 10);
    console.log(`Missing preview (${preview.length}/${report.missingRepositories.length}): ${preview.join(", ")}`);
  } else {
    console.log("No missing repositories detected.");
  }

  if (report.errors.length > 0) {
    console.warn("Errors encountered during verification:");
    for (const error of report.errors.slice(0, 10)) {
      console.warn(` - ${error.repo}: ${error.message ?? "unknown error"}`);
    }
    if (report.errors.length > 10) {
      console.warn(` ...and ${report.errors.length - 10} more.`);
    }
    process.exitCode = 1;
  }
}

function thisServiceOutputPath(fileName: string): string {
  return path.join(process.cwd(), "output", fileName);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  runCleanupCli().catch((error) => {
    console.error("Repository cleanup failed:", error);
    process.exitCode = 1;
  });
}
