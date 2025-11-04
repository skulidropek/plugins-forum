import { Database, Info, RefreshCw, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { ApiService } from "../services/api";

interface CacheInfo {
	url: string;
	metadata: {
		etag?: string;
		lastModified?: string;
		cachedAt: number;
		version: number;
	};
	size: string;
}

export function CacheManager(): React.JSX.Element {
	const [cacheInfo, setCacheInfo] = useState<CacheInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [showManager, setShowManager] = useState(false);

	const loadCacheInfo = useCallback(async (): Promise<void> => {
		try {
			const info = await ApiService.getCacheInfo();
			setCacheInfo(info);
		} catch (error) {
			console.error("Failed to load cache info:", error);
		}
	}, []);

	const handleClearCache = async (): Promise<void> => {
		if (
			!confirm(
				"Are you sure you want to clear the cache? This will force fresh downloads on next load.",
			)
		) {
			return;
		}

		setLoading(true);
		try {
			await ApiService.clearCache();
			await loadCacheInfo();
			alert("Cache cleared successfully!");
		} catch (error) {
			console.error("Failed to clear cache:", error);
			alert("Failed to clear cache");
		} finally {
			setLoading(false);
		}
	};

	const formatDate = (timestamp: number): string => {
		return new Date(timestamp).toLocaleString();
	};

	const getFileName = (url: string): string => {
		return url.split("/").pop() || url;
	};

	useEffect(() => {
		if (showManager) {
			void loadCacheInfo();
		}
	}, [showManager, loadCacheInfo]);

	if (!showManager) {
		return (
			<button
				type="button"
				onClick={() => setShowManager(true)}
				className="fixed bottom-4 right-4 bg-gray-700 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg transition-colors duration-200 z-50"
				title="Cache Manager"
			>
				<Database size={20} />
			</button>
		);
	}

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
			<div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] overflow-hidden">
				<div className="p-6 border-b border-gray-200">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<Database size={24} className="text-blue-600" />
							<h2 className="text-xl font-semibold text-gray-900">
								Cache Manager
							</h2>
						</div>
						<button
							type="button"
							onClick={() => setShowManager(false)}
							className="text-gray-400 hover:text-gray-600 text-2xl"
						>
							×
						</button>
					</div>
				</div>

				<div className="p-6">
					<div className="flex items-center justify-between mb-6">
						<div className="flex items-center gap-2 text-sm text-gray-600">
							<Info size={16} />
							<span>
								Cache helps reduce data usage by storing files locally
							</span>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => {
									void loadCacheInfo();
								}}
								disabled={loading}
								className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
							>
								<RefreshCw size={14} />
								Refresh
							</button>
							<button
								type="button"
								onClick={() => {
									void handleClearCache();
								}}
								disabled={loading}
								className="flex items-center gap-2 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
							>
								<Trash2 size={14} />
								Clear Cache
							</button>
						</div>
					</div>

					{cacheInfo.length === 0 ? (
						<div className="text-center py-8 text-gray-500">
							<Database size={48} className="mx-auto mb-2 opacity-50" />
							<p>No cached files found</p>
						</div>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full border border-gray-200 rounded-lg overflow-hidden">
								<thead className="bg-gray-50">
									<tr>
										<th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
											File
										</th>
										<th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
											Size
										</th>
										<th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
											Cached At
										</th>
										<th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
											ETag
										</th>
										<th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
											Last Modified
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-200">
									{cacheInfo.map((cache) => (
										<tr key={cache.url} className="hover:bg-gray-50">
											<td className="px-4 py-3 text-sm font-medium text-gray-900">
												{getFileName(cache.url)}
											</td>
											<td className="px-4 py-3 text-sm text-gray-600 font-mono">
												{cache.size}
											</td>
											<td className="px-4 py-3 text-sm text-gray-600">
												{formatDate(cache.metadata.cachedAt)}
											</td>
											<td
												className="px-4 py-3 text-sm text-gray-600 font-mono max-w-xs truncate"
												title={cache.metadata.etag}
											>
												{cache.metadata.etag || "—"}
											</td>
											<td className="px-4 py-3 text-sm text-gray-600">
												{cache.metadata.lastModified
													? formatDate(
															new Date(cache.metadata.lastModified).getTime(),
														)
													: "—"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					<div className="mt-6 p-4 bg-blue-50 rounded-lg">
						<h3 className="text-sm font-medium text-blue-800 mb-2">
							How caching works:
						</h3>
						<ul className="text-sm text-blue-700 space-y-1">
							<li>• Files are automatically cached after first download</li>
							<li>
								• Cache checks for file updates using ETags and Last-Modified
								headers
							</li>
							<li>
								• Only downloads files when they've actually changed on the
								server
							</li>
							<li>
								• Reduces bandwidth usage from ~50MB to just a few KB when files
								haven't changed
							</li>
							<li>
								• Cache is persistent and only updates when server files change
							</li>
						</ul>
					</div>
				</div>
			</div>
		</div>
	);
}
