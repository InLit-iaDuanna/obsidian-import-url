import {FailureInfo, SourceType, StructuredDigest} from "../types";
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

	return "Untitled";
}

function renderList(items: string[]): string {
	if (items.length === 0) {
		return "- 无";
	}

	return items.map((item) => `- ${item}`).join("\n");
}

function renderWarningSummary(warnings: string[]): string {
	return warnings.length > 0 ? warnings.join("；") : "无";
}

export function buildProcessingFileName(host: string, suffix: string, date: Date): string {
	return `${formatFileTimestamp(date)} - Processing - ${sanitizeNoteTitle(host) || "source"} - ${suffix}.md`;
}

export function buildSuccessFileName(title: string, date: Date): string {
	return `${formatFileTimestamp(date)} - ${ensureDisplayTitle(title)}.md`;
}

export function buildFailedFileName(title: string, suffix: string, date: Date): string {
	return `${formatFileTimestamp(date)} - Failed - ${ensureDisplayTitle(title)} - ${suffix}.md`;
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
	digest: StructuredDigest;
}): string {
	const {frontmatter, digest} = input;

	return [
		renderFrontmatter(frontmatter),
		"",
		"# 摘要",
		"",
		"## 一句话总结",
		"",
		digest.summary || "无",
		"",
		"## 核心要点",
		"",
		renderList(digest.keyPoints),
		"",
		"## 关键信息",
		"",
		renderList(digest.keyFacts),
		"",
		"## 可执行事项 / 相关线索",
		"",
		renderList(digest.actionItems),
		"",
		"# 全量整理版",
		"",
		digest.fullOrganizedMarkdown || "无",
		"",
		"# 来源",
		"",
		`- 原始链接: ${input.sourceUrl}`,
		`- 来源类型: ${input.sourceType}`,
		`- 来源标题: ${frontmatter.sourceTitle || "未知"}`,
		`- 抓取时间: ${frontmatter.clippedAt}`,
		`- 处理模型: ${frontmatter.model}`,
		`- 警告: ${renderWarningSummary(digest.warnings)}`,
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
		`- 原始链接: ${input.sourceUrl}`,
		`- 模型: ${failure.model ?? frontmatter.model}`,
		`- API 地址: ${failure.apiBaseUrl ?? "未知"}`,
		`- 请求接口: ${failure.requestUrl ?? "未知"}`,
		`- Request ID: ${failure.requestId ?? "未知"}`,
		`- HTTP 状态: ${failure.httpStatus ?? "未知"}`,
		`- 记录时间: ${frontmatter.clippedAt}`,
	].join("\n");
}
