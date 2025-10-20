import Prism from "prismjs";
import type React from "react";
import { useEffect, useRef } from "react";

// Импортируем нужные языки и темы
import "prismjs/components/prism-csharp";
import "prismjs/themes/prism-tomorrow.css";

interface CodeHighlightProps {
	code: string;
	language?: string;
	className?: string;
}

export const CodeHighlight: React.FC<CodeHighlightProps> = ({
	code,
	language = "csharp",
	className = "",
}) => {
	const codeRef = useRef<HTMLElement>(null);

	useEffect(() => {
		if (codeRef.current) {
			// Ensure the element reflects current language and code before highlighting
			codeRef.current.className = `language-${language}`;
			codeRef.current.textContent = code;
			Prism.highlightElement(codeRef.current);
		}
	}, [code, language]);

	return (
		<pre className={`language-${language} ${className}`}>
			<code ref={codeRef} className={`language-${language}`}>
				{code}
			</code>
		</pre>
	);
};
