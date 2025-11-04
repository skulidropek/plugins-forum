/**
 * Compares two semantic version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 *
 * Examples:
 * - compareVersions("1.2.3", "1.2.2") = 1
 * - compareVersions("1.2.2", "1.2.3") = -1
 * - compareVersions("1.2.3", "1.2.3") = 0
 * - compareVersions("2.0.0", "1.9.9") = 1
 */
export function compareVersions(
	a: string | null | undefined,
	b: string | null | undefined,
): number {
	// Handle null/undefined versions
	if (!a && !b) return 0;
	if (!a) return -1;
	if (!b) return 1;

	// Clean version strings (remove 'v' prefix if present)
	const cleanA = a.toLowerCase().replace(/^v/, "");
	const cleanB = b.toLowerCase().replace(/^v/, "");

	// Handle special format where 1.1.22 might mean 1.1.2.2
	function parseVersion(version: string): number[] {
		const parts = version.split(".");
		const result: number[] = [];

		for (const part of parts) {
			const num = parseInt(part, 10) || 0;

			// If this number has multiple digits and we're past the first two parts,
			// split it into individual digits
			if (result.length >= 2 && num >= 10) {
				const digits = num
					.toString()
					.split("")
					.map((d) => parseInt(d, 10));
				result.push(...digits);
			} else {
				result.push(num);
			}
		}

		return result;
	}

	const partsA = parseVersion(cleanA);
	const partsB = parseVersion(cleanB);

	// Pad to same length
	const maxLength = Math.max(partsA.length, partsB.length);
	while (partsA.length < maxLength) partsA.push(0);
	while (partsB.length < maxLength) partsB.push(0);

	// Compare numerically - higher numbers = newer
	for (let i = 0; i < maxLength; i++) {
		const diff = partsA[i] - partsB[i];
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}

	return 0;
}

/**
 * Sorts an array of plugins by version (newest first)
 */
export function sortPluginsByVersion<
	T extends { plugin_version?: string | null },
>(plugins: T[]): T[] {
	return [...plugins].sort((a, b) => {
		// Sort by version in descending order (newest first)
		return -compareVersions(a.plugin_version, b.plugin_version);
	});
}

/**
 * Groups plugins by name and sorts each group by version
 */
export function groupAndSortPluginsByVersion<
	T extends {
		plugin_name: string;
		plugin_version?: string | null;
	},
>(plugins: T[]): Record<string, T[]> {
	const groups: Record<string, T[]> = {};

	// Group plugins by name
	plugins.forEach((plugin) => {
		const name = plugin.plugin_name || "Unknown";
		if (!groups[name]) {
			groups[name] = [];
		}
		groups[name].push(plugin);
	});

	// Sort each group by version (newest first)
	Object.keys(groups).forEach((name) => {
		groups[name] = sortPluginsByVersion(groups[name]);
	});

	return groups;
}
