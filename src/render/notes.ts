import {FailureInfo, SourceType, StructuredDigest} from "../types";
import {renderConceptDraftList} from "../wiki-links";
import {FrontmatterInput, renderFrontmatter} from "./frontmatter";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function formatTimezoneOffset(date: Date): string {
	const minutes = -date.getTimezoneOffset();
	const sign = minutes >= 0 ? "+" : "-";
	const absolute = Math.abs(minutes);
	const hours = Math.floor(absolute / 60);
	const mins = absolute % 60;
	return `${sign}${pad(hours)}:${pad(mins)}`;
}

export function formatClippedAt(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${formatTimezoneOffset(date)}`;
}

export function formatFileTimestamp(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function randomHexSuffix(): string {
	return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
}

export function sanitizeNoteTitle(rawTitle: string): string {
	return rawTitle
		.replace(/[[\]\\:*?"<>|#^/]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
		.trim();
}

export function ensureDisplayTitle(...candidates: string[]): string {
	for (const candidate of candidates) {
		const sanitized = sanitizeNoteTitle(candidate);
		if (sanitized) {
			return sanitized;
		}
	}

	return "未命名";
}

function renderSourceType(sourceType: SourceType): string {
	return sourceType === "pdf" ? "PDF" : "网页";
}

function renderList(items: string[]): string {
	if (items.length === 0) {
		return "- 无";
	}

	return items.map((item) => `- ${item}`).join("\n");
}

function renderNumberedList(items: string[]): string {
	if (items.length === 0) {
		return "无";
	}

	return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function renderWarningSummary(warnings: string[]): string {
	return warnings.length > 0 ? warnings.join("；") : "无";
}

function renderPath(path: string | undefined): string {
	return path?.trim() || "无";
}

function escapeObsidianLinks(markdown: string): string {
	return markdown.replace(/\[\[([^\]\n]+)\]\]/gu, (_match, target: string) => {
		const display = target.split("|").pop() || target;
		return display.split("#")[0] || display;
	});
}

export function buildProcessingFileName(host: string, date: Date): string {
	return `${formatFileTimestamp(date)} - 处理中 - ${sanitizeNoteTitle(host) || "来源"}.md`;
}

export function buildSuccessFileName(title: string, date: Date): string {
	return `${formatFileTimestamp(date)} - AI整理 - ${ensureDisplayTitle(title)}.md`;
}

export function buildOriginalFileName(title: string, date: Date): string {
	return `${formatFileTimestamp(date)} - 原文 - ${ensureDisplayTitle(title)}.md`;
}

export function buildFailedFileName(title: string, date: Date): string {
	return `${formatFileTimestamp(date)} - 失败 - ${ensureDisplayTitle(title)}.md`;
}

export function renderProcessingNote(input: FrontmatterInput): string {
	return [
		renderFrontmatter(input),
		"",
		"# 导入中",
		"",
		"该笔记正在处理中，请稍候。",
	].join("\n");
}

export function renderSuccessNote(input: {
	frontmatter: FrontmatterInput;
	sourceType: SourceType;
	sourceUrl: string;
	wikiConceptsFolder: string;
	digest: StructuredDigest;
	originalNotePath?: string;
}): string {
	const {frontmatter, digest} = input;

	return [
		renderFrontmatter(frontmatter),
		"",
		`# ${frontmatter.title}`,
		"",
		"## 核心摘要",
		"",
		digest.summary || "无",
		"",
		"## 关键结论",
		"",
		renderNumberedList(digest.keyPoints),
		"",
		"## 事实与依据",
		"",
		renderList(digest.keyFacts),
		"",
		"## 后续行动",
		"",
		renderList(digest.actionItems),
		"",
		"## 待入库概念",
		"",
		"以下概念仅作为候选进入知识库管理，批准前不会写入正式概念图谱。",
		"",
		renderConceptDraftList(digest.concepts),
		"",
		"## 成文整理",
		"",
		escapeObsidianLinks(digest.fullOrganizedMarkdown || "无"),
		"",
		"# 来源",
		"",
		`- 原文笔记路径：${renderPath(input.originalNotePath)}`,
		`- 原始链接：${input.sourceUrl}`,
		`- 来源类型：${renderSourceType(input.sourceType)}`,
		`- 来源标题：${frontmatter.sourceTitle || "未知"}`,
		`- 抓取时间：${frontmatter.clippedAt}`,
		`- 处理模型：${frontmatter.model}`,
		`- 警告：${renderWarningSummary(digest.warnings)}`,
	].join("\n");
}

export function renderOriginalNote(input: {
	frontmatter: FrontmatterInput;
	sourceType: SourceType;
	sourceUrl: string;
	markdown: string;
	warnings: string[];
	structuredNotePath?: string;
}): string {
	const {frontmatter} = input;

	return [
		renderFrontmatter(frontmatter),
		"",
		"# 原文",
		"",
		escapeObsidianLinks(input.markdown || "无"),
		"",
		"# 来源",
		"",
		`- AI 整理笔记路径：${renderPath(input.structuredNotePath)}`,
		`- 原始链接：${input.sourceUrl}`,
		`- 来源类型：${renderSourceType(input.sourceType)}`,
		`- 来源标题：${frontmatter.sourceTitle || "未知"}`,
		`- 抓取时间：${frontmatter.clippedAt}`,
		`- 警告：${renderWarningSummary(input.warnings)}`,
	].join("\n");
}

export function renderFailureNote(input: {
	frontmatter: FrontmatterInput;
	sourceUrl: string;
	failure: FailureInfo;
}): string {
	const {frontmatter, failure} = input;

	return [
		renderFrontmatter(frontmatter),
		"",
		"# 导入失败",
		"",
		"## 阶段",
		"",
		failure.stage,
		"",
		"## 错误",
		"",
		failure.errorMessage,
		"",
		"## 建议",
		"",
		failure.suggestion,
		"",
		"## 来源",
		"",
		`- 原始链接：${input.sourceUrl}`,
		`- 模型：${failure.model ?? frontmatter.model}`,
		`- API 地址：${failure.apiBaseUrl ?? "未知"}`,
		`- 请求接口：${failure.requestUrl ?? "未知"}`,
		`- 请求 ID：${failure.requestId ?? "未知"}`,
		`- HTTP 状态：${failure.httpStatus ?? "未知"}`,
		`- 记录时间：${frontmatter.clippedAt}`,
	].join("\n");
}
