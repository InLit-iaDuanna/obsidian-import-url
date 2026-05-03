import {Readability} from "@mozilla/readability";
import {htmlToMarkdown} from "obsidian";
import {PipelineError, WebpageExtractionResult, WebpageImage} from "../types";

const REMOVED_TAGS = ["script", "style", "iframe", "link", "source", "video", "audio", "noscript", "svg", "canvas", "img"];
const IMAGE_SKIP_PATTERN = /(avatar|profile|icon|emoji|emote|logo|sprite|pixel|tracker|advert|ads?|social|share|cookie|loader|spacer|thumb|thumbnail|avatar|badge|qr)/iu;
const IMAGE_DATA_URL_PATTERN = /^(?:data|blob):/iu;

function normalizePlainTextLineBreaks(text: string): string {
	return text.replace(/\r\n?/gu, "\n");
}

function decodePdfBytes(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let result = "";
	const chunkSize = 0x8000;

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		result += String.fromCharCode(...chunk);
	}

	return result;
}

function decodePdfLiteralString(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index]!;
		if (char !== "\\") {
			result += char;
			continue;
		}

		const next = value[index + 1];
		if (next === undefined) {
			break;
		}
		index += 1;

		if (next === "n") {
			result += "\n";
		} else if (next === "r") {
			result += "\r";
		} else if (next === "t") {
			result += "\t";
		} else if (next === "b" || next === "f") {
			result += " ";
		} else if (/^[0-7]$/u.test(next)) {
			let octal = next;
			for (let count = 0; count < 2 && /^[0-7]$/u.test(value[index + 1] ?? ""); count += 1) {
				octal += value[index + 1];
				index += 1;
			}
			result += String.fromCharCode(Number.parseInt(octal, 8));
		} else {
			result += next;
		}
	}

	return result;
}

function decodePdfHexString(value: string): string {
	const hex = value.replace(/\s+/gu, "");
	let result = "";
	for (let index = 0; index < hex.length - 1; index += 2) {
		const code = Number.parseInt(hex.slice(index, index + 2), 16);
		if (Number.isFinite(code)) {
			result += String.fromCharCode(code);
		}
	}
	return result;
}

function parsePositiveInteger(value: string | null | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getImageSourceCandidate(image: HTMLImageElement): string {
	const candidates = [
		image.getAttribute("src"),
		image.getAttribute("data-src"),
		image.getAttribute("data-original"),
		image.getAttribute("data-lazy-src"),
		image.getAttribute("data-url"),
	];

	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) {
			return trimmed;
		}
	}

	const srcset = image.getAttribute("srcset")?.trim();
	if (!srcset) {
		return "";
	}

	const firstCandidate = srcset.split(",")[0]?.trim().split(/\s+/u)[0]?.trim();
	return firstCandidate || "";
}

function resolveAbsoluteUrl(rawUrl: string, baseUrl?: string): string | null {
	const trimmed = rawUrl.trim();
	if (!trimmed || IMAGE_DATA_URL_PATTERN.test(trimmed)) {
		return null;
	}

	try {
		const resolved = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
		if (!["http:", "https:"].includes(resolved.protocol)) {
			return null;
		}
		return resolved.toString();
	} catch {
		return null;
	}
}

function extractImageCaption(image: HTMLImageElement): string {
	const figure = image.closest("figure");
	const figureCaption = figure?.querySelector("figcaption")?.textContent?.trim();
	if (figureCaption) {
		return figureCaption;
	}

	const siblingCaption = image.parentElement?.querySelector(":scope > figcaption")?.textContent?.trim();
	if (siblingCaption) {
		return siblingCaption;
	}

	const parentCaption = image.parentElement?.nextElementSibling?.textContent?.trim();
	if (parentCaption && /caption|figcaption|图片说明|图注/iu.test(parentCaption)) {
		return parentCaption;
	}

	return "";
}

function stripImageElements(document: Document): void {
	for (const image of Array.from(document.querySelectorAll("img"))) {
		image.remove();
	}

	for (const source of Array.from(document.querySelectorAll("picture source, source"))) {
		source.remove();
	}
}

function htmlToMarkdownWithoutImages(html: string): string {
	const document = new DOMParser().parseFromString(html, "text/html");
	stripImageElements(document);
	return htmlToMarkdown(document.body?.innerHTML || document.documentElement.innerHTML).trim();
}

function getImageWarning(reason: string): string {
	return `图片已跳过：${reason}`;
}

function shouldSkipImage(image: HTMLImageElement, absoluteUrl: string): string | null {
	const metadataText = [
		image.getAttribute("alt"),
		image.getAttribute("title"),
		image.getAttribute("id"),
		image.getAttribute("class"),
		image.closest("figure")?.getAttribute("class"),
		image.closest("figure")?.getAttribute("id"),
	].filter(Boolean).join(" ");

	if (IMAGE_DATA_URL_PATTERN.test(absoluteUrl)) {
		return "内嵌数据图片";
	}

	if (!absoluteUrl) {
		return "无有效图片地址";
	}

	if (IMAGE_SKIP_PATTERN.test(metadataText)) {
		return "疑似装饰、头像或追踪图片";
	}

	const width = parsePositiveInteger(image.getAttribute("width") ?? image.getAttribute("data-width"));
	const height = parsePositiveInteger(image.getAttribute("height") ?? image.getAttribute("data-height"));
	if (width !== undefined && height !== undefined && width <= 96 && height <= 96) {
		return "尺寸过小";
	}

	return null;
}

function collectImagesFromHtml(html: string, baseUrl?: string): WebpageImage[] {
	if (!html.trim()) {
		return [];
	}

	const document = new DOMParser().parseFromString(html, "text/html");
	const images: WebpageImage[] = [];
	const elements = Array.from(document.querySelectorAll("img"));

	for (const [index, image] of elements.entries()) {
		const sourceCandidate = getImageSourceCandidate(image);
		const absoluteUrl = resolveAbsoluteUrl(sourceCandidate, baseUrl);
		const alt = image.getAttribute("alt")?.trim() || "";
		const title = image.getAttribute("title")?.trim() || "";
		const caption = extractImageCaption(image);
		if (!absoluteUrl) {
			images.push({
				index,
				url: sourceCandidate,
				alt,
				title,
				caption,
				downloadStatus: "skipped",
				warning: getImageWarning("无有效图片地址"),
			});
			continue;
		}

		const skipReason = shouldSkipImage(image, absoluteUrl);
		if (skipReason) {
			images.push({
				index,
				url: absoluteUrl,
				alt,
				title,
				caption,
				downloadStatus: "skipped",
				warning: getImageWarning(skipReason),
			});
			continue;
		}

		images.push({
			index,
			url: absoluteUrl,
			alt,
			title,
			caption,
			downloadStatus: "pending",
		});
	}

	return images;
}

function normalizeExtractedPdfText(text: string): string {
	return normalizePlainTextLineBreaks(text)
		.split("")
		.map((char) => {
			const code = char.charCodeAt(0);
			return code < 32 && char !== "\n" && char !== "\t" ? " " : char;
		})
		.join("")
		.replace(/[ \t]{2,}/gu, " ")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function extractPdfOperatorText(rawPdf: string): string {
	const textBlocks = rawPdf.match(/BT[\s\S]*?ET/gu) ?? [rawPdf];
	const extracted: string[] = [];

	for (const block of textBlocks) {
		const literalMatches = block.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|'|"|TJ)?/gu);
		for (const match of literalMatches) {
			const rawValue = match[0].replace(/\s*(?:Tj|'|"|TJ)?\s*$/u, "");
			extracted.push(decodePdfLiteralString(rawValue.slice(1, -1)));
		}

		const hexMatches = block.matchAll(/<([0-9a-fA-F\s]+)>\s*(?:Tj|TJ)?/gu);
		for (const match of hexMatches) {
			extracted.push(decodePdfHexString(match[1] ?? ""));
		}
	}

	return normalizeExtractedPdfText(extracted.join("\n"));
}

export function extractPdfTextContent(buffer: ArrayBuffer): {markdown: string; warnings: string[]} {
	const rawPdf = decodePdfBytes(buffer);
	const extracted = extractPdfOperatorText(rawPdf);
	if (extracted.length >= 40) {
		return {
			markdown: extracted,
			warnings: [],
		};
	}

	const printableFallback = normalizeExtractedPdfText(rawPdf
		.split("")
		.map((char) => {
			const code = char.charCodeAt(0);
			return char === "\t" || char === "\n" || char === "\r" || code >= 32 ? char : " ";
		})
		.join(""));
	if (printableFallback.length >= 80) {
		return {
			markdown: printableFallback,
			warnings: ["PDF 文本提取使用了保守回退，排版和顺序可能不完整。"],
		};
	}

	throw new PipelineError({
		stage: "extract",
		errorMessage: "无法在本地从 PDF 提取可读文本。",
		suggestion: "该 PDF 可能是扫描件、加密文件或使用压缩文本流。请换用可复制文字的 PDF，或先将 PDF 转为文本后再导入。",
	});
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
		images: [],
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
		const images = posts.flatMap((post) => collectImagesFromHtml(post.cooked ?? "", rawUrl));
		const markdownSections = posts.map((post, index) => {
			const author = post.name?.trim() || post.username?.trim() || `用户 ${index + 1}`;
			const bodyMarkdown = htmlToMarkdownWithoutImages(scrubHtml(post.cooked ?? ""));
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
			images,
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

export function extractWebpageContent(html: string, sourceUrl?: string): WebpageExtractionResult {
	try {
		const plainTextFallback = extractReaderFallbackContent(html);
		if (plainTextFallback) {
			return plainTextFallback;
		}

		const document = new DOMParser().parseFromString(html, "text/html");
		const readable = new Readability(document, {charThreshold: 0});
		const article = readable.parse();
		const baseHtml = article?.content || document.body?.innerHTML || "";
		const images = collectImagesFromHtml(html, sourceUrl);

		let markdown = "";
		if (baseHtml) {
			markdown = htmlToMarkdownWithoutImages(scrubHtml(baseHtml));
		}

		if (!markdown) {
			const fallbackHtml = document.body?.innerHTML ?? "";
			if (fallbackHtml.trim()) {
				markdown = htmlToMarkdownWithoutImages(scrubHtml(fallbackHtml));
			}
		}

		if (!markdown) {
			throw new PipelineError({
				stage: "extract",
				errorMessage: "无法从网页提取可读 Markdown 内容。",
				suggestion: "请确认链接是公开网页正文页，而不是需要登录或只返回脚本壳的页面。",
			});
		}

		return {
			title: article?.title?.trim() || document.title?.trim() || "",
			byline: article?.byline?.trim() || "",
			excerpt: article?.excerpt?.trim() || "",
			markdown,
			images,
			warnings: [],
		};
	} catch (error) {
		if (error instanceof PipelineError) {
			throw error;
		}

		throw new PipelineError({
			stage: "extract",
			errorMessage: error instanceof Error ? error.message : "网页正文提取失败。",
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
