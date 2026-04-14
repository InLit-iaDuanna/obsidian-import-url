import {Readability} from "@mozilla/readability";
import {htmlToMarkdown} from "obsidian";
import {PipelineError, WebpageExtractionResult} from "../types";

const REMOVED_TAGS = ["script", "style", "iframe", "img", "link", "source", "video", "audio", "noscript", "svg", "canvas"];

function normalizePlainTextLineBreaks(text: string): string {
	return text.replace(/\r\n?/gu, "\n");
}

function extractReaderFallbackContent(text: string): WebpageExtractionResult | null {
	const normalized = normalizePlainTextLineBreaks(text).trim();
	if (!normalized) {
		return null;
	}

	const looksLikeHtml = /<\/?[a-z][^>]*>/iu.test(normalized);
	const markdownMarker = "\nMarkdown Content:\n";
	if (looksLikeHtml && !normalized.includes(markdownMarker)) {
		return null;
	}

	const titleMatch = normalized.match(/^Title:\s*(.+)$/imu);
	const markerIndex = normalized.indexOf(markdownMarker);
	const markdown = (markerIndex >= 0 ? normalized.slice(markerIndex + markdownMarker.length) : normalized).trim();
	if (!markdown) {
		return null;
	}

	const summarySource = markdown
		.split(/\n{2,}/u)
		.map((block) => block.trim())
		.find(Boolean) ?? "";

	return {
		title: titleMatch?.[1]?.trim() || "",
		byline: "",
		excerpt: summarySource.slice(0, 280),
		markdown,
		warnings: [],
	};
}

function unwrapReaderEnvelope(text: string): string {
	const normalized = normalizePlainTextLineBreaks(text).trim();
	const marker = "\nMarkdown Content:\n";
	const markerIndex = normalized.indexOf(marker);
	return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length).trim() : normalized;
}

function getDiscourseTopicJsonUrl(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		if (!/\/t\//u.test(url.pathname) || url.pathname.endsWith(".json")) {
			return null;
		}

		const next = new URL(url.toString());
		next.pathname = `${next.pathname.replace(/\/+$/u, "")}.json`;
		next.hash = "";
		return next.toString();
	} catch {
		return null;
	}
}

export function extractSiteJsonContent(rawUrl: string, text: string): WebpageExtractionResult | null {
	const discourseJsonUrl = getDiscourseTopicJsonUrl(rawUrl);
	if (!discourseJsonUrl) {
		return null;
	}

	const normalized = unwrapReaderEnvelope(text);
	try {
		const parsed = JSON.parse(normalized) as {
			title?: string;
			post_stream?: {
				posts?: Array<{
					post_number?: number;
					username?: string;
					name?: string;
					cooked?: string;
				}>;
			};
		};
		const posts = parsed.post_stream?.posts ?? [];
		if (posts.length === 0) {
			return null;
		}

		const firstPost = posts[0];
		const markdownSections = posts.map((post, index) => {
			const author = post.name?.trim() || post.username?.trim() || `用户 ${index + 1}`;
			const bodyMarkdown = htmlToMarkdown(post.cooked ?? "").trim();
			if (!bodyMarkdown) {
				return "";
			}

			if (index === 0) {
				return bodyMarkdown;
			}

			return [
				`## 回复 ${post.post_number ?? index + 1} · ${author}`,
				"",
				bodyMarkdown,
			].join("\n");
		}).filter(Boolean);
		const markdown = markdownSections.join("\n\n").trim();
		if (!markdown) {
			return null;
		}

		const excerpt = markdown
			.split(/\n{2,}/u)
			.map((block) => block.trim())
			.find(Boolean) ?? "";

		return {
			title: parsed.title?.trim() || "",
			byline: firstPost?.name?.trim() || firstPost?.username?.trim() || "",
			excerpt: excerpt.slice(0, 280),
			markdown,
			warnings: [],
		};
	} catch {
		return null;
	}
}

export function getSiteJsonFallbackUrl(rawUrl: string): string | null {
	return getDiscourseTopicJsonUrl(rawUrl);
}

function removeTag(html: string, tagName: string): string {
	const blockPattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
	const singlePattern = new RegExp(`<${tagName}\\b[^>]*\\/?>`, "gi");
	return html.replace(blockPattern, "").replace(singlePattern, "");
}

export function scrubHtml(html: string): string {
	let scrubbed = html;
	for (const tagName of REMOVED_TAGS) {
		scrubbed = removeTag(scrubbed, tagName);
	}

	return scrubbed
		.replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function extractWebpageContent(html: string): WebpageExtractionResult {
	try {
		const plainTextFallback = extractReaderFallbackContent(html);
		if (plainTextFallback) {
			return plainTextFallback;
		}

		const scrubbedHtml = scrubHtml(html);
		const document = new DOMParser().parseFromString(scrubbedHtml, "text/html");
		const readable = new Readability(document, {charThreshold: 0});
		const article = readable.parse();

		let markdown = "";
		if (article?.content) {
			markdown = htmlToMarkdown(article.content).trim();
		}

		if (!markdown) {
			const fallbackHtml = document.body?.innerHTML ?? "";
			if (fallbackHtml.trim()) {
				markdown = htmlToMarkdown(fallbackHtml).trim();
			}
		}

		if (!markdown) {
			throw new PipelineError({
				stage: "extract",
				errorMessage: "No readable Markdown content could be extracted from the page.",
				suggestion: "请确认链接是公开网页正文页，而不是需要登录或只返回脚本壳的页面。",
			});
		}

		return {
			title: article?.title?.trim() || document.title?.trim() || "",
			byline: article?.byline?.trim() || "",
			excerpt: article?.excerpt?.trim() || "",
			markdown,
			warnings: [],
		};
	} catch (error) {
		if (error instanceof PipelineError) {
			throw error;
		}

		throw new PipelineError({
			stage: "extract",
			errorMessage: error instanceof Error ? error.message : "Failed to extract webpage content.",
			suggestion: "网页正文提取失败，请稍后重试，或换一个结构更简单的页面。",
		});
	}
}

export function estimateMarkdownTokens(markdown: string): number {
	return Math.ceil(markdown.length / 4);
}

export function truncateMarkdown(markdown: string, maxContentTokens: number): {markdown: string; warnings: string[]} {
	if (estimateMarkdownTokens(markdown) <= maxContentTokens) {
		return {markdown, warnings: []};
	}

	const hardLimit = maxContentTokens * 4;
	const sliced = markdown.slice(0, hardLimit);
	const paragraphBoundary = sliced.lastIndexOf("\n\n");
	const truncated = (paragraphBoundary >= 0 ? sliced.slice(0, paragraphBoundary) : sliced).trimEnd();

	return {
		markdown: truncated,
		warnings: ["源网页内容在发送给模型前已按长度限制截断。"],
	};
}
