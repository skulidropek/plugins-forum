import React from "react";
import type { IndexedPlugin } from "../types/plugin";
import { findPluginGlobalIndex } from "../utils/pluginUtils";
import { groupAndSortPluginsByVersion } from "../utils/versionUtils";
import { ErrorBoundary } from "./ErrorBoundary";
import { PluginCard } from "./PluginCard";

interface PluginGridProps {
	plugins: IndexedPlugin[];
	loading?: boolean;
	allPlugins?: IndexedPlugin[]; // All plugins for calculating global index
}

export const PluginGrid: React.FC<PluginGridProps> = ({
	plugins,
	loading = false,
	allPlugins,
}) => {
	// Sort plugins by version within each group (same name)
	const sortedPlugins = React.useMemo(() => {
		const groups = groupAndSortPluginsByVersion(plugins);

		// Flatten back to array while maintaining version sort within groups
		const result: IndexedPlugin[] = [];
		Object.values(groups).forEach((groupPlugins) => {
			result.push(...groupPlugins);
		});

		return result;
	}, [plugins]);
	if (loading) {
		return (
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
				{["a", "b", "c", "d", "e", "f"].map((key) => (
					<div
						key={key}
						className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden animate-pulse"
					>
						<div className="p-6">
							<div className="h-6 bg-gray-200 rounded mb-4"></div>
							<div className="h-4 bg-gray-200 rounded mb-2"></div>
							<div className="h-4 bg-gray-200 rounded mb-4 w-3/4"></div>
							<div className="h-4 bg-gray-200 rounded mb-2"></div>
							<div className="h-4 bg-gray-200 rounded mb-4 w-1/2"></div>
							<div className="flex space-x-2">
								<div className="h-8 bg-gray-200 rounded w-20"></div>
								<div className="h-8 bg-gray-200 rounded w-20"></div>
							</div>
						</div>
					</div>
				))}
			</div>
		);
	}

	if (plugins.length === 0) {
		return (
			<div className="text-center py-12">
				<div className="text-gray-500 text-lg mb-2">No plugins found</div>
				<div className="text-gray-400 text-sm">
					Try adjusting your search criteria
				</div>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{sortedPlugins.map((plugin, index) => {
				// Find the global index of this plugin in the original array
				const globalIndex = allPlugins
					? findPluginGlobalIndex(plugin, allPlugins)
					: index;

				return (
					<ErrorBoundary
						key={`${plugin.repository?.full_name || "unknown"}-${
							plugin.file?.path || "unknown"
						}-${index}`}
					>
						<PluginCard
							plugin={plugin}
							pluginIndex={globalIndex >= 0 ? globalIndex : index}
						/>
					</ErrorBoundary>
				);
			})}
		</div>
	);
};
