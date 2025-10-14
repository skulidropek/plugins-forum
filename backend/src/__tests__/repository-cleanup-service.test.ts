import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryCleanupService } from "../repository-cleanup-service.js";

// CHANGE: Переписали тест с явными типами, чтобы покрыть очистку удалённых репозиториев без `any`.
// WHY: Новые правила ESLint из фронтенда запрещают нестрого типизированный код; тест обязан соответствовать инварианту строгой типизации.
// QUOTE(TЗ): "И добавь в проект eslint Перенеси eslint просто из frontend части"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

type MinimalFetchResponse = {
  status: number;
  ok: boolean;
};

type RepositoryKey = `${string}/${string}`;

interface TestRepositoryInfo {
  readonly full_name?: RepositoryKey;
}

interface TestPluginEntry {
  readonly repository?: TestRepositoryInfo;
}

interface TestPluginData {
  readonly generated_at: string;
  readonly query: string;
  readonly count: number;
  readonly items: TestPluginEntry[];
}

interface TestAuthorDiscovered {
  readonly generated_at: string;
  readonly source: string;
  readonly count: number;
  readonly repositories: RepositoryKey[];
}

interface TestAuthorFinderState {
  last_updated: string;
  readonly current_author_index: number;
  readonly processed_authors: Record<
    string,
    {
      last_processed: string;
      repositories_found: number;
      success: boolean;
    }
  >;
  discovered_repositories: RepositoryKey[];
}

interface TestCrawlerStateEntry {
  last_crawled: string;
  plugins_count: number;
  success: boolean;
  errors: string[];
}

interface TestCrawlerState {
  last_updated: string;
  total_repositories_processed: number;
  successful_crawls: number;
  failed_crawls: number;
  readonly processed_repositories: Record<RepositoryKey, TestCrawlerStateEntry>;
}

interface TestIndexerState {
  readonly version?: string;
  readonly currentVariant?: number;
  readonly currentPage?: number;
  readonly seenKeys: Record<string, boolean>;
}

interface TestDeletedReport {
  readonly generated_at: string;
  readonly count: number;
  readonly repositories: RepositoryKey[];
}

void test("RepositoryCleanupService prunes deleted repositories while retaining errored ones", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-service-"));

  try {
    const inputDir = path.join(tempRoot, "input");
    const outputDir = path.join(tempRoot, "output");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    const now = new Date("2025-02-15T10:00:00.000Z");
    const existingRepo: RepositoryKey = "exists/repo";
    const deletedRepo: RepositoryKey = "deleted/repo";
    const errorRepo: RepositoryKey = "error/repo";

    await writeJson(path.join(outputDir, "oxide_plugins.json"), {
      generated_at: "2025-01-01T00:00:00.000Z",
      query: "test-query",
      count: 3,
      items: [
        { repository: { full_name: existingRepo } },
        { repository: { full_name: deletedRepo } },
        { repository: { full_name: errorRepo } }
      ]
    } satisfies TestPluginData);

    await writeJson(path.join(outputDir, "crawled_plugins.json"), {
      generated_at: "2025-01-01T00:00:00.000Z",
      query: "crawl-query",
      count: 3,
      items: [
        { repository: { full_name: existingRepo } },
        { repository: { full_name: deletedRepo } },
        { repository: { full_name: errorRepo } }
      ]
    } satisfies TestPluginData);

    await writeJson(path.join(outputDir, "author_discovered_repositories.json"), {
      generated_at: "2025-01-01T00:00:00.000Z",
      source: "unit-test",
      count: 3,
      repositories: [existingRepo, deletedRepo, errorRepo]
    } satisfies TestAuthorDiscovered);

    await writeJson(path.join(outputDir, "author_finder_state.json"), {
      last_updated: "2025-01-01T00:00:00.000Z",
      current_author_index: 0,
      processed_authors: {
        exists: { last_processed: "2025-01-01T00:00:00.000Z", repositories_found: 1, success: true },
        deleted: { last_processed: "2025-01-01T00:00:00.000Z", repositories_found: 1, success: true },
        error: { last_processed: "2025-01-01T00:00:00.000Z", repositories_found: 1, success: true }
      },
      discovered_repositories: [existingRepo, deletedRepo, errorRepo]
    } satisfies TestAuthorFinderState);

    await writeJson(path.join(outputDir, "crawler_state.json"), {
      last_updated: "2025-01-01T00:00:00.000Z",
      total_repositories_processed: 3,
      successful_crawls: 3,
      failed_crawls: 0,
      processed_repositories: {
        [existingRepo]: {
          last_crawled: "2025-01-01T00:00:00.000Z",
          plugins_count: 2,
          success: true,
          errors: []
        },
        [deletedRepo]: {
          last_crawled: "2025-01-01T00:00:00.000Z",
          plugins_count: 1,
          success: true,
          errors: []
        },
        [errorRepo]: {
          last_crawled: "2025-01-01T00:00:00.000Z",
          plugins_count: 1,
          success: true,
          errors: []
        }
      }
    } satisfies TestCrawlerState);

    await writeJson(path.join(outputDir, "state.json"), {
      version: "1.0",
      currentVariant: 0,
      currentPage: 0,
      seenKeys: {
        [`${existingRepo}#Existing.cs#abc`]: true,
        [`${deletedRepo}#Deleted.cs#def`]: true,
        [`${errorRepo}#Error.cs#ghi`]: true
      }
    } satisfies TestIndexerState);

    await writeJson(path.join(outputDir, "deleted_repositories.json"), {
      generated_at: "2025-01-01T00:00:00.000Z",
      count: 0,
      repositories: []
    } satisfies TestDeletedReport);

    const manualRepositories: readonly string[] = [
      `https://github.com/${existingRepo}`,
      `https://github.com/${deletedRepo}`,
      errorRepo
    ];
    await writeJson(path.join(inputDir, "manual-repositories.json"), manualRepositories);

    const fetchCalls: string[] = [];

    const service = new RepositoryCleanupService(
      {
        inputDir,
        outputDir
      },
      {
        fetchFn: (url: string): Promise<MinimalFetchResponse> => {
          fetchCalls.push(url);

          if (url.endsWith(existingRepo)) {
            return Promise.resolve({ status: 200, ok: true });
          }
          if (url.endsWith(deletedRepo)) {
            return Promise.resolve({ status: 404, ok: false });
          }
          if (url.endsWith(errorRepo)) {
            return Promise.resolve({ status: 500, ok: false });
          }

          return Promise.resolve({ status: 200, ok: true });
        },
        now: (): Date => now,
        log: (): void => {
          // Тест отключает логирование, чтобы не засорять вывод.
        }
      }
    );

    const report = await service.run();

    assert.equal(report.scannedRepositories, 3);
    assert.deepEqual(new Set(report.missingRepositories), new Set<RepositoryKey>([deletedRepo]));
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.repo, errorRepo);

    const oxide = await readJson<TestPluginData>(path.join(outputDir, "oxide_plugins.json"));
    assert.equal(oxide.count, 2);
    assert.equal(oxide.items.length, 2);
    assert.ok(oxide.items.every((item) => item.repository?.full_name !== deletedRepo));
    assert.equal(oxide.generated_at, now.toISOString());

    const crawled = await readJson<TestPluginData>(path.join(outputDir, "crawled_plugins.json"));
    assert.equal(crawled.count, 2);
    assert.equal(crawled.items.length, 2);
    assert.ok(crawled.items.every((item) => item.repository?.full_name !== deletedRepo));
    assert.equal(crawled.generated_at, now.toISOString());

    const authorDiscovered = await readJson<TestAuthorDiscovered>(path.join(outputDir, "author_discovered_repositories.json"));
    assert.equal(authorDiscovered.count, 2);
    assert.deepEqual(authorDiscovered.repositories.sort(), [errorRepo, existingRepo]);

    const authorFinderState = await readJson<TestAuthorFinderState>(path.join(outputDir, "author_finder_state.json"));
    assert.equal(authorFinderState.discovered_repositories.length, 2);
    const processedAuthors = authorFinderState.processed_authors;
    const existsEntry = processedAuthors.exists;
    const deletedEntry = processedAuthors.deleted;
    const errorEntry = processedAuthors.error;
    assert.ok(existsEntry);
    assert.ok(deletedEntry);
    assert.ok(errorEntry);
    assert.equal(existsEntry.repositories_found, 1);
    assert.equal(deletedEntry.repositories_found, 0);
    assert.equal(errorEntry.repositories_found, 1);
    assert.equal(authorFinderState.last_updated, now.toISOString());

    const crawlerState = await readJson<TestCrawlerState>(path.join(outputDir, "crawler_state.json"));
    assert.equal(Object.keys(crawlerState.processed_repositories).length, 2);
    assert.ok(!(deletedRepo in crawlerState.processed_repositories));
    assert.equal(crawlerState.total_repositories_processed, 2);
    assert.equal(crawlerState.failed_crawls + crawlerState.successful_crawls, 2);
    assert.equal(crawlerState.last_updated, now.toISOString());

    const indexerState = await readJson<TestIndexerState>(path.join(outputDir, "state.json"));
    assert.ok(!(`${deletedRepo}#Deleted.cs#def` in indexerState.seenKeys));

    const manual = await readJson<string[]>(path.join(inputDir, "manual-repositories.json"));
    assert.deepEqual([...manual].sort(), [errorRepo, `https://github.com/${existingRepo}`]);

    const deletedReport = await readJson<TestDeletedReport>(path.join(outputDir, "deleted_repositories.json"));
    assert.equal(deletedReport.count, 1);
    assert.deepEqual(deletedReport.repositories, [deletedRepo]);

    assert.equal(fetchCalls.length, 3);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
