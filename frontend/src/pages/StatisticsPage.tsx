import { Code } from "lucide-react";
import type React from "react";
import { Link } from "react-router-dom";
import { GoogleAnalyticsStats } from "../components/GoogleAnalyticsStats";

interface StatisticsPageProps {
	loading?: boolean;
}

export const StatisticsPage: React.FC<StatisticsPageProps> = ({
	loading = false,
}) => {
	if (loading) {
		return (
			<div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6">
				<div className="max-w-7xl mx-auto">
					<div className="text-center py-12">
						<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
						<p className="mt-4 text-gray-600">Loading statistics...</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6">
			<div className="max-w-7xl mx-auto">
				{/* Header */}
				<div className="text-center mb-8">
					<div className="flex items-center justify-center space-x-3 mb-4">
						<div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-xl flex items-center justify-center">
							<Code className="h-6 w-6 text-blue-600" />
						</div>
						<h1 className="text-4xl md:text-5xl font-bold text-gray-900">
							Website Analytics
						</h1>
					</div>
					<p className="text-xl text-gray-600 max-w-2xl mx-auto mb-6">
						Real-time website analytics and visitor insights powered by Google
						Analytics
					</p>

					{/* Navigation Links */}
					<div className="flex items-center justify-center space-x-4">
						<Link
							to="/"
							className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 transition-all duration-200 text-sm font-medium"
						>
							🏠 Home
						</Link>
						<Link
							to="/statistics"
							className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
						>
							📊 Statistics
						</Link>
					</div>
				</div>

				{/* Google Analytics Dashboard */}
				<GoogleAnalyticsStats />
			</div>
		</div>
	);
};
