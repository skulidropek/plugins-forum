import type { PluginRepository } from "../types/plugin";

// CHANGE: Introduced helper that filters out repositories flagged as deleted by backend report.
// WHY: Frontend must ignore repositories listed in backend/output/deleted_repositories.json.
// QUOTE(TЗ): "Можешь добавить на фронт проверку ... Типо что бы он игнорировал репозитории из этого списка"
// REF: REQ-REMOTE-CLEANUP-001
// SOURCE: internal-analysis

const deletedRepositoriesCache = new Map<string, Set<string>>();

type DeletedRepositoriesPayload = {
	repositories?: string[];
};

function isDeletedRepositoriesPayload(
	value: unknown,
): value is DeletedRepositoriesPayload {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const payload = value as DeletedRepositoriesPayload;
	if (!("repositories" in payload)) {
		return true;
	}
	if (!Array.isArray(payload.repositories)) {
		return false;
	}
	return payload.repositories.every((repo) => typeof repo === "string");
}

async function fetchDeletedRepositories(baseUrl: string): Promise<Set<string>> {
	if (deletedRepositoriesCache.has(baseUrl)) {
		const cached = deletedRepositoriesCache.get(baseUrl);
		if (cached) return cached;
	}

	const response = await fetch(`${baseUrl}/deleted_repositories.json`, {
		cache: "no-store",
	});

	if (!response.ok) {
		console.warn(
			"[deleted-repo-filter] Failed to load deleted_repositories.json:",
			response.status,
			response.statusText,
		);
		const emptySet = new Set<string>();
		deletedRepositoriesCache.set(baseUrl, emptySet);
		return emptySet;
	}

	const rawData = (await response.json()) as unknown;
	const data = isDeletedRepositoriesPayload(rawData)
		? rawData
		: { repositories: [] };
	const entries = Array.isArray(data.repositories) ? data.repositories : [];
	const repoSet = new Set(entries.map((repo) => repo.toLowerCase()));
	deletedRepositoriesCache.set(baseUrl, repoSet);
	return repoSet;
}

export async function filterDeletedRepositories<
	T extends { repository: PluginRepository },
>(items: T[], baseUrl: string): Promise<T[]> {
	const deletedRepos = await fetchDeletedRepositories(baseUrl);
	if (deletedRepos.size === 0) {
		return items;
	}
	return items.filter((item) => {
		const repoFullName = item.repository?.full_name;
		if (typeof repoFullName !== "string" || repoFullName.trim() === "") {
			return true;
		}
		const normalized = repoFullName.toLowerCase();
		return !deletedRepos.has(normalized);
	});
}

export function resetDeletedRepositoriesCache(): void {
	deletedRepositoriesCache.clear();
}
