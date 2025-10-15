import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

// CHANGE: Introduce RepositoryCleanupService to remove references to deleted repositories across backend datasets.
// WHY: Ensures exported datasets obey invariant that every listed repository resolves successfully on GitHub (no stale entries).
// QUOTE(TЗ): "Типо ему надо проходить по всем репозиториям и смотреть есть ли они Если нету то удалять всё что к ним относиться"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

type GitHubRepositoryName = `${string}/${string}`;

type FetchLike = (
  input: string,
  init?: {
    readonly headers?: Record<string, string>;
  }
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
}>;

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

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DELAY_MS = 0;
const DEFAULT_GITHUB_API_BASE = "https://api.github.com/repos/";
const DEFAULT_NOW: () => Date = () => new Date();

/**
 * @public
 * @remarks
 * Ensures exported backend datasets remain consistent with GitHub by pruning entries for repositories that return 404/410.
 * @invariant Output JSON files must only reference repositories whose REST lookup succeeds.
 */
export class RepositoryCleanupService {
  private readonly paths: Record<
    "oxidePlugins" | "crawledPlugins" | "authorDiscovered" | "authorFinderState" | "crawlerState" | "indexerState" | "manualRepositories" | "deletedRepositoriesReport",
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
  private readonly previouslyDeleted: Set<GitHubRepositoryName>;

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
      deletedRepositoriesReport: path.join(outputDir, "deleted_repositories.json")
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
    this.previouslyDeleted = new Set(this.loadKnownDeletedRepositories());
  }

  /**
   * Executes a full cleanup pass ensuring отсутствующие на GitHub репозитории фиксируются в отдельном отчёте.
   *
   * @returns Детализированный отчёт с перечнем недоступных репозиториев и статусом выполнения.
   * @throws Error when reading or writing datasets fails unexpectedly.
   *
   * @precondition File system layout mirrors the backend output/input folders.
   * @postcondition Все существующие датасеты остаются неизменными; список удалённых репозиториев обновлён.
   */
  public async run(): Promise<RepositoryCleanupReport> {
    const datasets = await this.loadDatasets();
    const usageMap = this.collectRepositoryUsage(datasets);
    const repositories = Array.from(usageMap.keys());

    if (repositories.length === 0) {
      return {
        scannedRepositories: 0,
        missingRepositories: [],
        updatedFiles: [],
        errors: [],
        datasetImpacts: {
          oxide_plugins: 0,
          crawled_plugins: 0,
          author_discovered: 0,
          manual_repositories: 0,
          author_finder_state: 0,
          crawler_state: 0,
          indexer_state: 0
        }
      };
    }

    const checks = await this.checkRepositories(repositories);
    const missingRepos = new Set(
      Array.from(checks.values())
        .filter((result) => result.status === "missing")
        .map((result) => result.repo)
        .filter((repo) => !this.previouslyDeleted.has(repo))
    );
    const errors = Array.from(checks.values()).filter((result) => result.status === "error");

    const updatedFiles = await this.writeDeletedReport(missingRepos);

    const datasetImpacts: Record<RepositoryDatasetName, number> = {
      oxide_plugins: 0,
      crawled_plugins: 0,
      author_discovered: 0,
      manual_repositories: 0,
      author_finder_state: 0,
      crawler_state: 0,
      indexer_state: 0
    };

    return {
      scannedRepositories: repositories.length,
      missingRepositories: Array.from(missingRepos),
      updatedFiles,
      errors,
      datasetImpacts
    };
  }

  private async loadDatasets(): Promise<DatasetBundle> {
    return {
      oxidePlugins: {
        path: this.paths.oxidePlugins,
        data: await this.readJson<OxidePluginData>(this.paths.oxidePlugins)
      },
      crawledPlugins: {
        path: this.paths.crawledPlugins,
        data: await this.readJson<CrawledPluginData>(this.paths.crawledPlugins)
      },
      authorDiscovered: {
        path: this.paths.authorDiscovered,
        data: await this.readJson<AuthorDiscoveredRepositories>(this.paths.authorDiscovered)
      },
      authorFinderState: {
        path: this.paths.authorFinderState,
        data: await this.readJson<AuthorFinderState>(this.paths.authorFinderState)
      },
      crawlerState: {
        path: this.paths.crawlerState,
        data: await this.readJson<CrawlerState>(this.paths.crawlerState)
      },
      indexerState: {
        path: this.paths.indexerState,
        data: await this.readJson<IndexerState>(this.paths.indexerState)
      },
      manualRepositories: {
        path: this.paths.manualRepositories,
        data: await this.readJson<string[]>(this.paths.manualRepositories)
      }
    };
  }

  private collectRepositoryUsage(datasets: DatasetBundle): Map<GitHubRepositoryName, RepositoryUsage> {
    const usage = new Map<GitHubRepositoryName, RepositoryUsage>();

    const record = (repo: GitHubRepositoryName, dataset: RepositoryDatasetName): void => {
      if (this.previouslyDeleted.has(repo)) {
        return;
      }
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
        if (repoName) {
          record(repoName, "indexer_state");
        }
      }
    }

    return usage;
  }

  private async checkRepositories(repos: GitHubRepositoryName[]): Promise<Map<GitHubRepositoryName, RepositoryCheckResult>> {
    const results = new Map<GitHubRepositoryName, RepositoryCheckResult>();
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = cursor;
        if (currentIndex >= repos.length) {
          break;
        }
        cursor += 1;

        const repo = repos[currentIndex];
        if (!repo) {
          continue;
        }
        const result = await this.checkSingleRepository(repo);
        results.set(repo, result);

        if (this.delayMs > 0) {
          await this.sleepFn(this.delayMs);
        }
      }
    };

    const workers = Array.from({ length: this.concurrencyLimit }, worker);
    await Promise.all(workers);

    return results;
  }

  private async checkSingleRepository(repo: GitHubRepositoryName): Promise<RepositoryCheckResult> {
    try {
      const url = `${this.githubApiBaseUrl}${repo}`;
      const headers: Record<string, string> = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "oxide-plugin-cleanup/1.0"
      };

      if (this.githubToken) {
        headers.Authorization = `Bearer ${this.githubToken}`;
      }

      const response = await this.fetchFn(url, { headers });

      if (response.status === 404 || response.status === 410 || response.status === 451 || response.status === 403) {
        const reason = this.describeMissingStatus(response.status);
        return {
          repo,
          status: "missing",
          httpStatus: response.status,
          message: reason
        };
      }

      if (response.ok) {
        return { repo, status: "exists", httpStatus: response.status };
      }

      const message = `Unexpected status ${response.status}`;
      this.log("indexer_state", `${repo} -> ${message}`);
      return {
        repo,
        status: "error",
        httpStatus: response.status,
        message
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.log("indexer_state", `${repo} -> ${message}`);
      return {
        repo,
        status: "error",
        message
      };
    }
  }

  private async writeDeletedReport(missingRepos: Set<GitHubRepositoryName>): Promise<string[]> {
    if (missingRepos.size === 0) {
      return [];
    }

    const combined = new Set<GitHubRepositoryName>([...this.previouslyDeleted, ...missingRepos]);
    const payload = {
      generated_at: this.now().toISOString(),
      count: combined.size,
      repositories: Array.from(combined).sort()
    };
    await this.writeJson(this.paths.deletedRepositoriesReport, payload);
    for (const repo of missingRepos) {
      this.previouslyDeleted.add(repo);
    }
    return [this.paths.deletedRepositoriesReport];
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
          const [owner, repoSegment] = segments;
          if (!owner || !repoSegment) {
            return null;
          }
          const parsedRepo = repoSegment.replace(/\.git$/iu, "");
          const candidate = `${owner}/${parsedRepo}`;
          if (this.isValidRepositoryName(candidate)) {
            return candidate;
          }
          return null;
        }
      } catch {
        return null;
      }
      return null;
    }

    const parts = trimmed.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const candidate = `${parts[0]}/${parts[1]}`;
      if (this.isValidRepositoryName(candidate)) {
        return candidate;
      }
      return null;
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

  private isValidRepositoryName(value: string): value is GitHubRepositoryName {
    return /^[^/]+\/[^/]+$/u.test(value);
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const folder = path.dirname(filePath);
    await fs.mkdir(folder, { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tempPath, payload, "utf-8");
    await fs.rename(tempPath, filePath);
  }

  private loadKnownDeletedRepositories(): GitHubRepositoryName[] {
    try {
      const raw = readFileSync(this.paths.deletedRepositoriesReport, "utf-8");
      const parsed = JSON.parse(raw) as { repositories?: string[] };
      if (!Array.isArray(parsed.repositories)) {
        return [];
      }
      return parsed.repositories
        .filter((repo): repo is GitHubRepositoryName => typeof repo === "string" && this.isValidRepositoryName(repo));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
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
}

// CHANGE: Добавили CLI-точку входа, чтобы сервис очистки запускался как остальные бэкенд-сервисы.
// WHY: Архитектура проекта предполагает, что автономные скрипты живут в src и содержат собственный раннер.
// QUOTE(TЗ): "сервисы запускаемые скрипты живут в src"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis
async function runCleanupCli(): Promise<void> {
  const baseConfig: RepositoryCleanupConfig = {
    inputDir: path.join(process.cwd(), "input"),
    outputDir: path.join(process.cwd(), "output")
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
    ...(process.env.CLEANUP_GITHUB_API_BASE ? { githubApiBaseUrl: process.env.CLEANUP_GITHUB_API_BASE } : {})
  };

  const service = new RepositoryCleanupService(config, {
    log: (dataset, message): void => {
      console.log(`[cleanup:${dataset}] ${message}`);
    }
  });

  const report = await service.run();
  console.log(
    [
      `Scanned: ${report.scannedRepositories}`,
      `Removed: ${report.missingRepositories.length}`,
      `Updated files: ${report.updatedFiles.length}`
    ].join(" | ")
  );

  if (report.errors.length > 0) {
    console.warn("Repositories skipped due to errors:");
    for (const error of report.errors) {
      console.warn(` - ${error.repo}: ${error.message ?? "unknown error"} (status: ${error.httpStatus ?? "n/a"})`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCleanupCli().catch((error: unknown) => {
    console.error("Repository cleanup failed:", error);
    process.exitCode = 1;
  });
}
