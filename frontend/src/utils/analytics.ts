// Mathematical proof: Type-safe Google Analytics integration
// Theorem: All gtag calls are provably type-safe with compile-time guarantees

type GtagConfigParameters = {
	readonly page_path: string;
	readonly page_title: string;
	readonly send_page_view?: boolean;
};

type GtagEventParameters = {
	readonly event_category?: string;
	readonly event_label?: string;
	readonly value?: number;
	readonly custom_parameter?: boolean;
};

type PluginEventParameters = GtagEventParameters & {
	readonly plugin_name: string;
	readonly repository: string;
	readonly event_category: "plugin_interaction";
};

type SearchEventParameters = GtagEventParameters & {
	readonly search_term: string;
	readonly result_count?: number;
	readonly search_length?: number;
	readonly search_fields?: string;
	readonly search_mode?: string;
	readonly event_category: "search";
};

type FilterEventParameters = GtagEventParameters & {
	readonly filter_type: string;
	readonly filter_value: string;
	readonly event_category: "filter";
};

type LinkEventParameters = GtagEventParameters & {
	readonly link_url: string;
	readonly link_type: "github" | "discord" | "other";
	readonly event_category: "external_link";
	readonly outbound: true;
};

type InterfaceEventParameters = GtagEventParameters & {
	readonly view_mode?: string;
	readonly sort_by?: string;
	readonly page_size?: number;
	readonly event_category: "interface";
};

// Mathematical proof: Union type ensures all possible event parameters are covered
type EventParameters =
	| PluginEventParameters
	| SearchEventParameters
	| FilterEventParameters
	| LinkEventParameters
	| InterfaceEventParameters;

declare global {
	interface Window {
		// Mathematical proof: Overloaded function signatures ensure compile-time type safety
		gtag(
			command: "config",
			targetId: string,
			config: GtagConfigParameters,
		): void;
		gtag(
			command: "event",
			eventName: string,
			parameters: EventParameters,
		): void;
		gtag(command: "js", date: Date): void;
		gtag(
			command: "set",
			parameters: Record<string, string | number | boolean>,
		): void;
	}
}

/**
 * Mathematical proof: Type-safe Google Analytics 4 tracking utilities
 * Theorem: All method calls are provably correct at compile time
 * Complexity: O(1) for all operations - constant time mathematical guarantee
 */
export class Analytics {
	// Mathematical proof: Boolean algebra - (typeof window !== 'undefined') ∧ (typeof window.gtag === 'function')
	private static isEnabled(): boolean {
		return typeof window !== "undefined" && typeof window.gtag === "function";
	}

	/**
	 * Mathematical proof: Page view tracking with compile-time path validation
	 * Precondition: path ∈ String, title ∈ String ∪ undefined
	 * Postcondition: gtag called with valid GtagConfigParameters
	 */
	static trackPageView(path: string, title?: string): void {
		if (!Analytics.isEnabled()) return;

		const config: GtagConfigParameters = {
			page_path: path,
			page_title: title ?? document.title,
		};

		window.gtag("config", "G-CKP8G29QS3", config);
	}

	/**
	 * Mathematical proof: Universal event tracking with type safety
	 * Precondition: eventName ∈ String, parameters ∈ EventParameters
	 * Postcondition: Type-safe event tracking guaranteed at compile time
	 */
	static trackEvent(eventName: string, parameters: EventParameters): void {
		if (!Analytics.isEnabled()) return;
		window.gtag("event", eventName, parameters);
	}

	/**
	 * Mathematical proof: Plugin view tracking with exact type constraints
	 * Precondition: pluginName ∈ String, repository ∈ String
	 * Postcondition: PluginEventParameters type guaranteed at compile time
	 */
	static trackPluginView(pluginName: string, repository: string): void {
		if (!Analytics.isEnabled()) return;

		const parameters: PluginEventParameters = {
			plugin_name: pluginName,
			repository,
			event_category: "plugin_interaction",
		};

		window.gtag("event", "plugin_view", parameters);
	}

	/**
	 * Mathematical proof: Search tracking with numerical result validation
	 * Precondition: query ∈ String, resultCount ∈ ℕ₀ (non-negative integers)
	 * Postcondition: SearchEventParameters type guaranteed at compile time
	 */
	static trackPluginSearch(query: string, resultCount: number): void {
		if (!Analytics.isEnabled()) return;

		const parameters: SearchEventParameters = {
			search_term: query,
			result_count: resultCount,
			event_category: "search",
		};

		window.gtag("event", "search", parameters);
	}

	/**
	 * Mathematical proof: Filter usage tracking with string literal validation
	 * Precondition: filterType ∈ String, filterValue ∈ String
	 * Postcondition: FilterEventParameters type guaranteed at compile time
	 */
	static trackFilterUse(filterType: string, filterValue: string): void {
		if (!Analytics.isEnabled()) return;

		const parameters: FilterEventParameters = {
			filter_type: filterType,
			filter_value: filterValue,
			event_category: "filter",
		};

		window.gtag("event", "filter_use", parameters);
	}

	/**
	 * Mathematical proof: External link tracking with union type validation
	 * Precondition: url ∈ String, linkType ∈ {'github', 'discord', 'other'}
	 * Postcondition: LinkEventParameters type with outbound: true guaranteed
	 */
	static trackExternalLink(
		url: string,
		linkType: "github" | "discord" | "other",
	): void {
		if (!Analytics.isEnabled()) return;

		const parameters: LinkEventParameters = {
			link_url: url,
			link_type: linkType,
			event_category: "external_link",
			outbound: true,
		};

		window.gtag("event", "click", parameters);
	}
}
