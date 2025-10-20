import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import "./styles/performance.css";
import App from "./App.tsx";
import { PluginDetail } from "./components/PluginDetail.tsx";
import { StatisticsPageWrapper } from "./pages/StatisticsPageWrapper.tsx";

// Initialize devtrace in development mode
if (import.meta.env.DEV) {
	await import("@ton-ai-core/devtrace")
		.then((m) =>
			m.installStackLogger({
				limit: 5, // number of stack frames
				skip: 0, // skip frames
				tail: false, // show full stack, not only tail
				ascending: true, // order root → call-site
				mapSources: true, // map sources to original files
				snippet: 1, // lines of code context
				preferApp: true, // prioritize app code
				onlyApp: false, // include libs as well
			}),
		)
		.catch(() => {});

	await import("@ton-ai-core/devtrace")
		.then((m) => m.installDevInstrumentation())
		.catch(() => {});
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element #root not found");
}
createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<App />} />
				<Route path="/plugin/:pluginId" element={<PluginDetail />} />
				<Route path="/statistics" element={<StatisticsPageWrapper />} />
			</Routes>
		</BrowserRouter>
	</StrictMode>,
);
