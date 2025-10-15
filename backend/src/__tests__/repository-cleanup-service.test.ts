import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryCleanupService } from "../repository-cleanup-service.js";

// CHANGE: Updated tests to reflect git-clone based verification for repository existence.
// WHY: Ensure cloned validation path records missing repositories without mutating datasets.
// QUOTE(TЗ): "Корчое давай юзать git clone и через него проверять"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

type RepositoryKey = `${string}/${string}`;

interface TestRepositoryInfo {
  readonly full_name?: RepositoryKey;
}

interface TestPluginEntry {
  readonly repository?: TestRepositoryInfo;
}

interface TestPluginData {
  readonly items: TestPluginEntry[];
}

interface TestAuthorDiscovered {
  readonly repositories: RepositoryKey[];
}

interface TestAuthorFinderState {
  readonly discovered_repositories: RepositoryKey[];
}

interface TestCrawlerState {
  readonly processed_repositories: Record<RepositoryKey, unknown>;
}

interface TestIndexerState {
  readonly seenKeys: Record<string, boolean>;
}

interface TestDeletedReport {
  readonly generated_at: string;
  readonly count: number;
  readonly repositories: RepositoryKey[];
}

void test("RepositoryCleanupService records missing repositories using git clone verification", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-service-"));

  try {
    const inputDir = path.join(tempRoot, "input");
    const outputDir = path.join(tempRoot, "output");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    const existingRepo: RepositoryKey = "exists/repo";
    const deletedRepo: RepositoryKey = "deleted/repo";
    const legalRepo: RepositoryKey = "legal/repo";
    const forbiddenRepo: RepositoryKey = "forbidden/repo";
    const flakyRepo: RepositoryKey = "flaky/repo";

    const oxideSeed: TestPluginData = {
      items: [
        { repository: { full_name: existingRepo } },
        { repository: { full_name: deletedRepo } },
        { repository: { full_name: legalRepo } },
        { repository: { full_name: forbiddenRepo } },
        { repository: { full_name: flakyRepo } },
      ],
    };
    await writeJson(path.join(outputDir, "oxide_plugins.json"), oxideSeed);

    const crawledSeed: TestPluginData = {
      items: [
        { repository: { full_name: existingRepo } },
        { repository: { full_name: deletedRepo } },
        { repository: { full_name: legalRepo } },
        { repository: { full_name: forbiddenRepo } },
        { repository: { full_name: flakyRepo } },
      ],
    };
    await writeJson(path.join(outputDir, "crawled_plugins.json"), crawledSeed);

    const discoveredSeed: TestAuthorDiscovered = {
      repositories: [existingRepo, deletedRepo, legalRepo, forbiddenRepo, flakyRepo],
    };
    await writeJson(path.join(outputDir, "author_discovered_repositories.json"), discoveredSeed);

    const authorFinderSeed: TestAuthorFinderState = {
      discovered_repositories: [existingRepo, deletedRepo, legalRepo, forbiddenRepo, flakyRepo],
    };
    await writeJson(path.join(outputDir, "author_finder_state.json"), authorFinderSeed);

    const crawlerSeed: TestCrawlerState = {
      processed_repositories: {
        [existingRepo]: {},
        [deletedRepo]: {},
        [legalRepo]: {},
        [forbiddenRepo]: {},
        [flakyRepo]: {},
      },
    };
    await writeJson(path.join(outputDir, "crawler_state.json"), crawlerSeed);

    const indexerSeed: TestIndexerState = {
      seenKeys: {
        [`${existingRepo}#path`]: true,
        [`${deletedRepo}#path`]: true,
        [`${legalRepo}#path`]: true,
        [`${forbiddenRepo}#path`]: true,
        [`${flakyRepo}#path`]: true,
      },
    };
    await writeJson(path.join(outputDir, "state.json"), indexerSeed);

    const deletedReportSeed: TestDeletedReport = {
      generated_at: "2025-01-01T00:00:00.000Z",
      count: 0,
      repositories: [],
    };
    await writeJson(path.join(outputDir, "deleted_repositories.json"), deletedReportSeed);

    const manualRepositories: readonly string[] = [
      `https://github.com/${existingRepo}`,
      `https://github.com/${deletedRepo}`,
      `https://github.com/${legalRepo}`,
      `https://github.com/${forbiddenRepo}`,
      flakyRepo,
    ];
    await writeJson(path.join(inputDir, "manual-repositories.json"), manualRepositories);

    const gitCloneCalls: string[] = [];
    const tempDirsCreated: string[] = [];
    const gitCloneStub = async (cloneUrl: string): Promise<void> => {
      gitCloneCalls.push(cloneUrl);
      if (cloneUrl.includes("deleted")) {
        throw createGitError("fatal: repository not found");
      }
      if (cloneUrl.includes("legal")) {
        throw createGitError("fatal: repository unavailable due to DMCA takedown.");
      }
      if (cloneUrl.includes("forbidden")) {
        throw createGitError("fatal: Access denied for user");
      }
      if (cloneUrl.includes("flaky")) {
        throw new Error("temporary network error");
      }
      // Simulate clone success by touching the target directory (already created by service).
      await Promise.resolve();
    };

    const tempDirStub = async (): Promise<string> => {
      const dir = await fs.mkdtemp(path.join(tempRoot, "clone-"));
      tempDirsCreated.push(dir);
      return dir;
    };

    const service = new RepositoryCleanupService(
      {
        inputDir,
        outputDir,
      },
      {
        gitClone: async (cloneUrl, targetDir, _timeoutMs): Promise<void> => {
          await gitCloneStub(cloneUrl);
          await fs.mkdir(targetDir, { recursive: true });
        },
        tempDir: tempDirStub,
        log: (): void => {
          // Silence logs during test.
        },
        now: (): Date => new Date("2025-02-15T10:00:00.000Z"),
      }
    );

    const report = await service.run();

    assert.equal(report.scannedRepositories, 5);
    assert.deepEqual(
      new Set(report.missingRepositories),
      new Set<RepositoryKey>([deletedRepo, legalRepo, forbiddenRepo])
    );

    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.repo, flakyRepo);

    assert.deepEqual(report.updatedFiles, [path.join(outputDir, "deleted_repositories.json")]);

    const oxide = await readJson<TestPluginData>(path.join(outputDir, "oxide_plugins.json"));
    assert.deepEqual(oxide, oxideSeed);

    const crawled = await readJson<TestPluginData>(path.join(outputDir, "crawled_plugins.json"));
    assert.deepEqual(crawled, crawledSeed);

    const authorDiscovered = await readJson<TestAuthorDiscovered>(path.join(outputDir, "author_discovered_repositories.json"));
    assert.deepEqual(authorDiscovered, discoveredSeed);

    const authorFinderState = await readJson<TestAuthorFinderState>(path.join(outputDir, "author_finder_state.json"));
    assert.deepEqual(authorFinderState, authorFinderSeed);

    const crawlerState = await readJson<TestCrawlerState>(path.join(outputDir, "crawler_state.json"));
    assert.deepEqual(crawlerState, crawlerSeed);

    const indexerState = await readJson<TestIndexerState>(path.join(outputDir, "state.json"));
    assert.deepEqual(indexerState, indexerSeed);

    const manual = await readJson<string[]>(path.join(inputDir, "manual-repositories.json"));
    assert.deepEqual(manual, Array.from(manualRepositories));

    const deletedReport = await readJson<TestDeletedReport>(path.join(outputDir, "deleted_repositories.json"));
    assert.equal(deletedReport.count, 3);
    assert.deepEqual(deletedReport.repositories, [deletedRepo, forbiddenRepo, legalRepo]);

    assert.equal(gitCloneCalls.length, 5);
    assert.ok(tempDirsCreated.length > 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function createGitError(message: string): Error & { stderr: Buffer } {
  const error = new Error(message) as Error & { stderr: Buffer };
  error.stderr = Buffer.from(message);
  return error;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
