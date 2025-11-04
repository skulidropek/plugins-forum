import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface GitHubRepository {
	full_name: string;
	name: string;
	html_url: string;
	description: string | null;
	default_branch: string;
	stargazers_count: number;
	forks_count: number;
	open_issues_count: number;
	owner: {
		login: string;
		html_url: string;
	};
}

interface AuthorRepositoryFinderState {
	last_updated: string;
	current_author_index: number;
	processed_authors: {
		[author: string]: {
			last_processed: string;
			repositories_found: number;
			success: boolean;
			error?: string;
		};
	};
	discovered_repositories: string[];
}

interface FoundRepositoryData {
	generated_at: string;
	source: string;
	count: number;
	repositories: string[];
}

interface OxidePluginData {
	items: {
		repository?: {
			owner_login?: string;
		};
	}[];
}

interface CrawledPluginData {
	items: {
		repository?: {
			owner_login?: string;
		};
	}[];
}

export class AuthorRepositoryFinder {
	private githubToken: string;
	private outputDir: string;
	private stateFile: string;
	private outputFile: string;
	private state: AuthorRepositoryFinderState;

	constructor(githubToken?: string) {
		if (!githubToken) {
			throw new Error("GitHub token is required");
		}

		this.githubToken = githubToken;
		this.outputDir = path.join(__dirname, "../output");
		this.stateFile = path.join(this.outputDir, "author_finder_state.json");
		this.outputFile = path.join(
			this.outputDir,
			"author_discovered_repositories.json",
		);

		this.state = this.createInitialState(); // Initialize first
		this.loadState();
	}

	private loadState(): void {
		if (fs.existsSync(this.stateFile)) {
			try {
				const stateData = fs.readFileSync(this.stateFile, "utf-8");
				this.state = JSON.parse(stateData);
			} catch (error) {
				console.error("Failed to load state, creating new one:", error);
				this.state = this.createInitialState();
			}
		} else {
			this.state = this.createInitialState();
		}
	}

	private createInitialState(): AuthorRepositoryFinderState {
		return {
			last_updated: new Date().toISOString(),
			current_author_index: 0,
			processed_authors: {},
			discovered_repositories: [],
		};
	}

	private saveState(): void {
		this.state.last_updated = new Date().toISOString();
		fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
	}

	private async fetchUserRepositories(
		username: string,
	): Promise<GitHubRepository[]> {
		const allRepos: GitHubRepository[] = [];
		let page = 1;
		const perPage = 100;

		while (true) {
			const url = `https://api.github.com/users/${username}/repos?per_page=${perPage}&page=${page}`;

			try {
				const response = await fetch(url, {
					headers: {
						Authorization: `token ${this.githubToken}`,
						Accept: "application/vnd.github.v3+json",
					},
				});

				if (!response.ok) {
					if (response.status === 404) {
						console.log(`User ${username} not found`);
						return [];
					}
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}

				const repos = (await response.json()) as GitHubRepository[];

				if (repos.length === 0) {
					break;
				}

				allRepos.push(...repos);

				if (repos.length < perPage) {
					break;
				}

				page++;

				// Rate limiting
				await new Promise((resolve) => setTimeout(resolve, 100));
			} catch (error) {
				console.error(`Error fetching repositories for ${username}:`, error);
				throw error;
			}
		}

		return allRepos;
	}

	private async cloneAndSearchRepository(
		repoFullName: string,
	): Promise<boolean> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
		const cloneUrl = `https://github.com/${repoFullName}.git`;

		try {
			// Clone repository (shallow clone for speed)
			console.log(`  Cloning ${repoFullName}...`);
			execSync(`git clone --depth 1 --quiet ${cloneUrl} ${tempDir}`, {
				stdio: "ignore",
				timeout: 30000, // 30 second timeout
			});

			// Search for Oxide plugins using grep
			try {
				const result = execSync(
					`grep -r --include="*.cs" "namespace Oxide.Plugins" ${tempDir}`,
					{ encoding: "utf8", timeout: 10000 },
				);

				if (result.trim()) {
					console.log(`  Found Oxide plugins in ${repoFullName}`);
					return true;
				}
			} catch (grepError) {
				// grep returns non-zero if no matches found, which is normal
				const status = (grepError as { status?: number }).status;
				if (status === 1) {
					// No matches found
					return false;
				}
				throw grepError;
			}

			return false;
		} catch (error) {
			const sig = (error as { signal?: string }).signal;
			if (sig === "SIGTERM") {
				console.log(`  Timeout cloning ${repoFullName}, skipping`);
			} else {
				console.error(
					`  Error processing ${repoFullName}:`,
					(error as Error).message,
				);
			}
			return false;
		} finally {
			// Clean up
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch (cleanupError) {
				console.warn(
					`Failed to cleanup ${tempDir}:`,
					(cleanupError as Error).message,
				);
			}
		}
	}

	private getAuthorsFromPluginFiles(): string[] {
		const authors = new Set<string>();

		// Read oxide_plugins.json
		const oxidePluginsPath = path.join(this.outputDir, "oxide_plugins.json");
		if (fs.existsSync(oxidePluginsPath)) {
			try {
				const oxideData: OxidePluginData = JSON.parse(
					fs.readFileSync(oxidePluginsPath, "utf-8"),
				);
				oxideData.items.forEach((item) => {
					if (item.repository?.owner_login) {
						authors.add(item.repository.owner_login);
					}
				});
			} catch (error) {
				console.error("Error reading oxide_plugins.json:", error);
			}
		}

		// Read crawled_plugins.json
		const crawledPluginsPath = path.join(
			this.outputDir,
			"crawled_plugins.json",
		);
		if (fs.existsSync(crawledPluginsPath)) {
			try {
				const crawledData: CrawledPluginData = JSON.parse(
					fs.readFileSync(crawledPluginsPath, "utf-8"),
				);
				crawledData.items.forEach((item) => {
					if (item.repository?.owner_login) {
						authors.add(item.repository.owner_login);
					}
				});
			} catch (error) {
				console.error("Error reading crawled_plugins.json:", error);
			}
		}

		return Array.from(authors);
	}

	private saveDiscoveredRepositories(): void {
		const outputData: FoundRepositoryData = {
			generated_at: new Date().toISOString(),
			source: "Author repository discovery from plugin authors",
			count: this.state.discovered_repositories.length,
			repositories: [...new Set(this.state.discovered_repositories)].sort(),
		};

		fs.writeFileSync(this.outputFile, JSON.stringify(outputData, null, 2));
	}

	async processAuthors(): Promise<void> {
		const authors = this.getAuthorsFromPluginFiles();
		console.log(`Found ${authors.length} unique authors to process`);

		const startIndex = this.state.current_author_index;

		for (let i = startIndex; i < authors.length; i++) {
			const author = authors[i];
			if (!author) continue;

			this.state.current_author_index = i;

			// Skip if recently processed (within last 7 days)
			const authorData = this.state.processed_authors[author];
			if (authorData) {
				const lastProcessed = new Date(authorData.last_processed);
				const daysSinceProcessed =
					(Date.now() - lastProcessed.getTime()) / (1000 * 60 * 60 * 24);

				if (daysSinceProcessed < 7) {
					console.log(
						`Skipping ${author} - processed ${Math.floor(daysSinceProcessed)} days ago`,
					);
					continue;
				}
			}

			console.log(`Processing author ${i + 1}/${authors.length}: ${author}`);

			try {
				// Get all repositories for this author
				const userRepos = await this.fetchUserRepositories(author);
				console.log(`Found ${userRepos.length} repositories for ${author}`);

				// Skip authors with too many repositories (likely organizations or very active users)
				if (userRepos.length > 100) {
					console.log(
						`  Skipping ${author} - too many repositories (${userRepos.length}), likely an organization`,
					);
					this.state.processed_authors[author] = {
						last_processed: new Date().toISOString(),
						repositories_found: 0,
						success: true,
						error: `Skipped - too many repositories (${userRepos.length})`,
					};
					continue;
				}

				let foundPluginRepos = 0;

				// Search for plugins in each repository
				for (const repo of userRepos) {
					const hasPlugins = await this.cloneAndSearchRepository(
						repo.full_name,
					);

					if (hasPlugins) {
						foundPluginRepos++;
						if (!this.state.discovered_repositories.includes(repo.full_name)) {
							this.state.discovered_repositories.push(repo.full_name);
							console.log(
								`  Discovered new plugin repository: ${repo.full_name}`,
							);
						}
					}

					// Small delay between repositories
					await new Promise((resolve) => setTimeout(resolve, 500));
				}

				this.state.processed_authors[author] = {
					last_processed: new Date().toISOString(),
					repositories_found: foundPluginRepos,
					success: true,
				};

				console.log(
					`Completed ${author}: found ${foundPluginRepos} plugin repositories`,
				);
			} catch (error) {
				console.error(`Failed to process ${author}:`, error);
				this.state.processed_authors[author] = {
					last_processed: new Date().toISOString(),
					repositories_found: 0,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}

			// Save state periodically
			this.saveState();
			this.saveDiscoveredRepositories();

			// Add delay between authors
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}

		// Reset index for next cycle
		this.state.current_author_index = 0;
		this.saveState();
		this.saveDiscoveredRepositories();

		console.log(
			`Completed processing all authors. Total discovered repositories: ${this.state.discovered_repositories.length}`,
		);
	}

	async run(): Promise<void> {
		console.log("Starting Author Repository Finder...");

		while (true) {
			try {
				await this.processAuthors();
				console.log("Cycle completed. Waiting 1 hour before next cycle...");
				await new Promise((resolve) => setTimeout(resolve, 60 * 60 * 1000)); // 1 hour
			} catch (error) {
				console.error("Error in main loop:", error);
				await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000)); // 5 minutes on error
			}
		}
	}
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
	const githubToken = process.env.GITHUB_TOKEN;

	if (!githubToken) {
		console.error("Please set GITHUB_TOKEN environment variable");
		process.exit(1);
	}

	async function main() {
		try {
			console.log("Starting standalone Author Repository Finder...");
			const finder = new AuthorRepositoryFinder(githubToken);

			// Check if we want to run once or continuously
			const continuous =
				(process.env.CONTINUOUS ?? "false").toLowerCase() === "true";

			if (continuous) {
				console.log("Running in continuous mode...");
				await finder.run(); // This will run forever
			} else {
				console.log("Running single cycle...");
				await finder.processAuthors();
				console.log("Single cycle completed.");
			}
		} catch (error) {
			console.error("Error:", error);
			process.exit(1);
		}
	}

	main().catch(console.error);
}
