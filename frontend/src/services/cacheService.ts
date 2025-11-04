export interface CacheMetadata {
	etag?: string;
	lastModified?: string;
	cachedAt: number;
	url: string;
	version: number;
}

export interface CachedData<T = unknown> {
	data: T;
	metadata: CacheMetadata;
}

export class CacheService {
	private static readonly CACHE_VERSION = 1;
	private static readonly CACHE_MAX_AGE_MS = 5 * 60 * 60 * 1000; // 5 hours
	private static readonly DB_NAME = "plugins_cache_db";
	private static readonly DB_VERSION = 1;
	private static readonly STORE_NAME = "plugin_files";

	private static db: IDBDatabase | null = null;

	private static async initDB(): Promise<IDBDatabase> {
		if (CacheService.db) return CacheService.db;

		return new Promise((resolve, reject) => {
			const request = indexedDB.open(
				CacheService.DB_NAME,
				CacheService.DB_VERSION,
			);

			request.onerror = (): void =>
				reject(
					new Error(
						request.error
							? `IndexedDB error: ${request.error.name || "Unknown"}`
							: "IndexedDB error",
					),
				);
			request.onsuccess = (): void => {
				CacheService.db = request.result;
				resolve(CacheService.db);
			};

			request.onupgradeneeded = (): void => {
				const db = request.result;
				if (!db.objectStoreNames.contains(CacheService.STORE_NAME)) {
					db.createObjectStore(CacheService.STORE_NAME, { keyPath: "url" });
				}
			};
		});
	}

	private static async getFromIndexedDB(
		url: string,
	): Promise<CachedData<unknown> | null> {
		try {
			const db = await CacheService.initDB();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(
					[CacheService.STORE_NAME],
					"readonly",
				);
				const store = transaction.objectStore(CacheService.STORE_NAME);
				const request = store.get(url);

				request.onerror = (): void =>
					reject(
						new Error(
							request.error
								? `IndexedDB error: ${request.error.name || "Unknown"}`
								: "IndexedDB error",
						),
					);
				request.onsuccess = (): void =>
					resolve((request.result as CachedData<unknown>) || null);
			});
		} catch (error) {
			console.warn("Failed to get from IndexedDB:", error);
			return null;
		}
	}

	private static async saveToIndexedDB(
		url: string,
		data: unknown,
		metadata: CacheMetadata,
	): Promise<void> {
		try {
			const db = await CacheService.initDB();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(
					[CacheService.STORE_NAME],
					"readwrite",
				);
				const store = transaction.objectStore(CacheService.STORE_NAME);
				const request = store.put({ url, data, metadata });

				request.onerror = (): void =>
					reject(
						new Error(
							request.error
								? `IndexedDB error: ${request.error.name || "Unknown"}`
								: "IndexedDB error",
						),
					);
				request.onsuccess = (): void => resolve();
			});
		} catch (error) {
			console.warn("Failed to save to IndexedDB:", error);
		}
	}

	private static isCacheVersionOutdated(metadata: CacheMetadata): boolean {
		return metadata.version !== CacheService.CACHE_VERSION;
	}

	private static isCacheExpired(metadata: CacheMetadata): boolean {
		return Date.now() - metadata.cachedAt >= CacheService.CACHE_MAX_AGE_MS;
	}

	private static async deleteFromIndexedDB(url: string): Promise<void> {
		try {
			const db = await CacheService.initDB();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(
					[CacheService.STORE_NAME],
					"readwrite",
				);
				const store = transaction.objectStore(CacheService.STORE_NAME);
				const request = store.delete(url);

				request.onerror = (): void =>
					reject(
						new Error(
							request.error
								? `IndexedDB error: ${request.error.name || "Unknown"}`
								: "IndexedDB error",
						),
					);
				request.onsuccess = (): void => resolve();
			});
		} catch (error) {
			console.warn("Failed to delete from IndexedDB:", error);
		}
	}

	private static async checkIfFileUpdated(
		url: string,
		cachedMetadata?: CacheMetadata,
	): Promise<{
		updated: boolean;
		newMetadata?: CacheMetadata;
	}> {
		try {
			// Use HEAD request to check file metadata without downloading content
			const response = await fetch(url, { method: "HEAD" });

			if (!response.ok) {
				return { updated: true }; // Treat as updated if we can't check
			}

			const etag = response.headers.get("etag");
			const lastModified = response.headers.get("last-modified");

			const newMetadata: CacheMetadata = {
				etag: etag || undefined,
				lastModified: lastModified || undefined,
				cachedAt: Date.now(),
				url,
				version: CacheService.CACHE_VERSION,
			};

			// If no cached metadata, file is new
			if (!cachedMetadata) {
				return { updated: true, newMetadata };
			}

			// Check if file has been updated based on ETag or Last-Modified
			const etagChanged =
				etag && cachedMetadata.etag && etag !== cachedMetadata.etag;
			const lastModifiedChanged =
				lastModified &&
				cachedMetadata.lastModified &&
				new Date(lastModified).getTime() !==
					new Date(cachedMetadata.lastModified).getTime();

			const hasMetadataChange = etagChanged || lastModifiedChanged;

			return {
				updated:
					hasMetadataChange ||
					CacheService.isCacheVersionOutdated(cachedMetadata),
				newMetadata,
			};
		} catch (error) {
			console.warn("Failed to check file update status:", error);
			return { updated: true }; // Treat as updated if check fails
		}
	}

	static async fetchWithCache<T = unknown>(url: string): Promise<T> {
		// Try to get cached data
		const cached = await CacheService.getFromIndexedDB(url);

		const cacheExpired = cached
			? CacheService.isCacheExpired(cached.metadata)
			: false;

		if (cacheExpired) {
			await CacheService.deleteFromIndexedDB(url);
		}

		// Check if file needs updating
		const cachedMetadata =
			cached && !cacheExpired ? cached.metadata : undefined;
		const { updated, newMetadata } = await CacheService.checkIfFileUpdated(
			url,
			cachedMetadata,
		);

		// If cached data exists and file hasn't been updated, return cached data
		if (cached && !cacheExpired && !updated) {
			console.log(`Using cached data for ${url}`);
			return cached.data as T;
		}

		// File has been updated or no cache exists, fetch new data
		console.log(`Fetching fresh data for ${url}`);

		try {
			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const data = (await response.json()) as T;

			// Create metadata for caching
			const metadata: CacheMetadata = newMetadata || {
				etag: response.headers.get("etag") || undefined,
				lastModified: response.headers.get("last-modified") || undefined,
				cachedAt: Date.now(),
				url,
				version: CacheService.CACHE_VERSION,
			};

			// Cache the new data
			await CacheService.saveToIndexedDB(url, data, metadata);

			return data;
		} catch (error) {
			// If fetch fails and we have cached data, use it as fallback
			if (cached && !cacheExpired) {
				console.warn("Fetch failed, using cached data as fallback:", error);
				return cached.data as T;
			}
			throw error;
		}
	}

	static async clearCache(): Promise<void> {
		try {
			const db = await CacheService.initDB();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(
					[CacheService.STORE_NAME],
					"readwrite",
				);
				const store = transaction.objectStore(CacheService.STORE_NAME);
				const request = store.clear();

				request.onerror = (): void =>
					reject(
						new Error(
							request.error
								? `IndexedDB error: ${request.error.name || "Unknown"}`
								: "IndexedDB error",
						),
					);
				request.onsuccess = (): void => resolve();
			});
		} catch (error) {
			console.warn("Failed to clear cache:", error);
		}
	}

	static async getCacheInfo(): Promise<
		Array<{ url: string; metadata: CacheMetadata; size: string }>
	> {
		try {
			const db = await CacheService.initDB();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(
					[CacheService.STORE_NAME],
					"readonly",
				);
				const store = transaction.objectStore(CacheService.STORE_NAME);
				const request = store.getAll();

				request.onerror = (): void =>
					reject(
						new Error(
							request.error
								? `IndexedDB error: ${request.error.name || "Unknown"}`
								: "IndexedDB error",
						),
					);
				request.onsuccess = (): void => {
					const results = request.result.map(
						(item: {
							url: string;
							metadata: CacheMetadata;
							data: unknown;
						}) => ({
							url: item.url,
							metadata: item.metadata,
							size: CacheService.formatBytes(JSON.stringify(item.data).length),
						}),
					);
					resolve(results);
				};
			});
		} catch (error) {
			console.warn("Failed to get cache info:", error);
			return [];
		}
	}

	private static formatBytes(bytes: number): string {
		if (bytes === 0) return "0 Bytes";
		const k = 1024;
		const sizes = ["Bytes", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
	}
}
