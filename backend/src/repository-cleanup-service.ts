import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// CHANGE: Reimplemented repository verification via shallow `git clone` to avoid GitHub REST rate limits.
// WHY: User requested git-based validation after API-driven approach produced false positives and lacked persistent state.
// QUOTE(TЗ): "Корчое давай юзать git clone и через него проверять твой апи нафиг не нужен"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

type GitHubRepositoryName = `${string}/${string}`;

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
}

interface OxidePluginEntry {
  readonly repository?: RepoInfo;
}

interface OxidePluginData {
  items: OxidePluginEntry[];
}

interface CrawledPluginEntry {
  readonly repository?: RepoInfo;
}

interface CrawledPluginData {
  items: CrawledPluginEntry[];
}

interface AuthorDiscoveredRepositories {
  repositories: GitHubRepositoryName[];
}

interface AuthorFinderState {
  discovered_repositories: GitHubRepositoryName[];
}

interface CrawlerState {
  processed_repositories: Record<string, unknown>;
}

interface IndexerState {
  seenKeys: Record<string, boolean>;
}

interface RepositoryCleanupConfig {
  readonly inputDir?: string;
  readonly outputDir?: string;
  readonly gitCloneTimeoutMs?: number;
}

type GitCloneFn = (cloneUrl: string, targetDir: string, timeoutMs: number) => Promise<void>;
type TempDirProvider = () => Promise<string>;

interface RepositoryCleanupDependencies {
  readonly log?: (dataset: RepositoryDatasetName, message: string) => void;
  readonly now?: () => Date;
  readonly gitClone?: GitCloneFn;
  readonly tempDir?: TempDirProvider;
}

interface RepositoryUsage {
  occurrences: number;
  datasets: Partial<Record<RepositoryDatasetName, number>>;
}

interface RepositoryCheckResult {
  readonly repo: GitHubRepositoryName;
  readonly status: "exists" | "missing" | "error";
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

const execFileAsync = promisify(execFile);
const DEFAULT_CLONE_TIMEOUT_MS = 60_000;

/**
 * @public
 * @remarks
 * Validates repository existence via shallow git clones and emits a JSON report of confirmed missing repositories.
 * @invariant Oxide dataset files are never mutated; only `deleted_repositories.json` is rewritten.
 */
export class RepositoryCleanupService {
  private readonly paths: Record<
    | "oxidePlugins"
    | "crawledPlugins"
    | "authorDiscovered"
    | "authorFinderState"
    | "crawlerState"
    | "indexerState"
    | "manualRepositories"
    | "deletedRepositoriesReport",
    string
  >;
  private readonly log: (dataset: RepositoryDatasetName, message: string) => void;
  private readonly now: () => Date;
  private readonly gitClone: GitCloneFn;
  private readonly tempDir: TempDirProvider;
  private readonly cloneTimeoutMs: number;

  public constructor(
    config: RepositoryCleanupConfig = {},
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
    };

    this.log =
      dependencies.log ??
      ((dataset, message): void => {
        console.log(`[cleanup:${dataset}] ${message}`);
      });
    const defaultNow = (): Date => new Date();
    this.now = dependencies.now ?? defaultNow;
    this.gitClone = dependencies.gitClone ?? this.defaultGitClone.bind(this);
    this.tempDir = dependencies.tempDir ?? this.defaultTempDir.bind(this);
    this.cloneTimeoutMs = config.gitCloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  }

  public async run(): Promise<RepositoryCleanupReport> {
    const datasets = await this.loadDatasets();
    const usageMap = this.collectRepositoryUsage(datasets);
    const repositories = Array.from(usageMap.keys()).sort();

    if (repositories.length === 0) {
      return {
        scannedRepositories: 0,
        missingRepositories: [],
        updatedFiles: [],
        errors: [],
        datasetImpacts: this.emptyImpacts(),
      };
    }

    const missing: GitHubRepositoryName[] = [];
    const errors: RepositoryCheckResult[] = [];

    for (const repo of repositories) {
      const result = await this.verifyRepositoryViaGit(repo);
      if (result.status === "missing") {
        missing.push(repo);
        this.log("indexer_state", `${repo} marked as missing: ${result.message ?? "clone failed"}`);
      } else if (result.status === "error") {
        errors.push(result);
        this.log("indexer_state", `${repo} produced error: ${result.message ?? "unknown"}`);
      }
    }

    await this.writeDeletedReport(missing);

    return {
      scannedRepositories: repositories.length,
      missingRepositories: missing,
      updatedFiles: [this.paths.deletedRepositoriesReport],
      errors,
      datasetImpacts: this.emptyImpacts(),
    };
  }

  private emptyImpacts(): Record<RepositoryDatasetName, number> {
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

  private async verifyRepositoryViaGit(repo: GitHubRepositoryName): Promise<RepositoryCheckResult> {
    // CHANGE: Validate repository reachability through a temporary shallow clone.
    // WHY: GitHub REST rate limits caused false positives; git clone mirrors real workflow access.
    // QUOTE(TЗ): "Корчое давай юзать git clone и через него проверять твой апи нафиг не нужен"
    // REF: REQ-REMOTE-CLEANUP-001
    // SOURCE: internal-analysis
    const cloneUrl = `https://github.com/${repo}.git`;
    const tempDir = await this.tempDir();

    try {
      await this.gitClone(cloneUrl, tempDir, this.cloneTimeoutMs);
      return { repo, status: "exists" };
    } catch (error) {
      const message = this.extractErrorMessage(error);
      if (this.isMissingRepositoryMessage(message)) {
        return { repo, status: "missing", message };
      }
      return { repo, status: "error", message };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (error && typeof error === "object") {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      if (stderr) {
        return typeof stderr === "string" ? stderr : stderr.toString("utf-8");
      }
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      if (stdout) {
        return typeof stdout === "string" ? stdout : stdout.toString("utf-8");
      }
      if ("message" in error && typeof (error as { message?: string }).message === "string") {
        return (error as { message: string }).message;
      }
    }
    return "Unknown git error.";
  }

  private isMissingRepositoryMessage(message: string): boolean {
    // CHANGE: Interpret common git error text as evidence of a removed repository.
    // WHY: Git reports textual errors instead of HTTP codes; we map phrases to deletion states.
    // QUOTE(TЗ): "Корчое давай юзать git clone и через него проверять" (отсутствующие считаются удалёнными)
    // REF: REQ-REMOTE-CLEANUP-001
    // SOURCE: internal-analysis
    const normalized = message.toLowerCase();
    return (
      normalized.includes("repository not found") ||
      normalized.includes("repository does not exist") ||
      normalized.includes("does not exist") ||
      normalized.includes("access denied") ||
      normalized.includes("fatal: repository") ||
      normalized.includes("unavailable") ||
      normalized.includes("dmca")
    );
  }

  private async defaultTempDir(): Promise<string> {
    const prefix = path.join(os.tmpdir(), "repo-check-");
    return fs.mkdtemp(prefix);
  }

  private async defaultGitClone(cloneUrl: string, targetDir: string, timeoutMs: number): Promise<void> {
    await execFileAsync("git", ["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet", cloneUrl, targetDir], {
      timeout: timeoutMs,
      windowsHide: true,
    });
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

  private async writeDeletedReport(missingRepos: GitHubRepositoryName[]): Promise<void> {
    const payload = {
      generated_at: this.now().toISOString(),
      count: missingRepos.length,
      repositories: [...missingRepos].sort(),
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
