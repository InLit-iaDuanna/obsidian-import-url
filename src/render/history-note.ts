import {ImportHistoryEntry} from "../types";
import {formatFileTimestamp, sanitizeNoteTitle} from "./notes";

function quoteYaml(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function renderMaybe(value: string | undefined): string {
	return value?.trim() || "无";
}

function renderStatus(status: ImportHistoryEntry["status"]): string {
	if (status === "complete") {
		return "完成";
	}
	if (status === "failed") {
		return "失败";
	}
	return "处理中";
}

function renderProgressStage(stage: ImportHistoryEntry["progressStage"]): string {
	const labels: Record<ImportHistoryEntry["progressStage"], string> = {
		queued: "排队中",
		preflight: "预检",
		fetching: "抓取",
		extracting: "提取",
		ai_call: "模型整理",
		saving: "保存",
		complete: "完成",
		failed: "失败",
	};
	return labels[stage];
}

function renderSourceType(sourceType: ImportHistoryEntry["sourceType"]): string {
	if (sourceType === "webpage") {
		return "网页";
	}
	if (sourceType === "pdf") {
		return "PDF";
	}
	return "无";
}

export function buildHistoryFileName(host: string, date: Date): string {
	return `${formatFileTimestamp(date)} - 导入记录 - ${sanitizeNoteTitle(host) || "来源"}.md`;
}

export function renderHistoryNote(entry: ImportHistoryEntry): string {
	return [
		"---",
		"type: 'import_url_history'",
		"graph_group: 'import-url-status'",
		"tags:",
		"  - 'import-url/history'",
		"  - 'import-url/generated'",
		`status: ${quoteYaml(entry.status)}`,
		`source_url: ${quoteYaml(entry.url)}`,
		`host: ${quoteYaml(entry.host)}`,
		`api_base_url: ${quoteYaml(entry.apiBaseUrl)}`,
		`model: ${quoteYaml(entry.model)}`,
		`submitted_at: ${quoteYaml(entry.submittedAt)}`,
		`progress_stage: ${quoteYaml(entry.progressStage)}`,
		`progress_percent: ${entry.progressPercent}`,
		`progress_updated_at: ${quoteYaml(entry.progressUpdatedAt)}`,
		`source_type: ${quoteYaml(entry.sourceType ?? "")}`,
		`result_note: ${quoteYaml(entry.notePath ?? "")}`,
		`original_note: ${quoteYaml(entry.originalNotePath ?? "")}`,
		"---",
		"",
		"# URL 导入记录",
		"",
		"## 请求",
		"",
		`- URL：${entry.url}`,
		`- 站点：${entry.host}`,
		`- API 地址：${entry.apiBaseUrl}`,
		`- 模型：${entry.model}`,
		`- 提交时间：${entry.submittedAt}`,
		"",
		"## 进度",
		"",
		`- 进度：${entry.progressPercent}%`,
		`- 阶段：${renderProgressStage(entry.progressStage)}`,
		`- 消息：${entry.progressMessage}`,
		`- 更新时间：${entry.progressUpdatedAt}`,
		"",
		"## 状态",
		"",
		`- 当前状态：${renderStatus(entry.status)}`,
		`- 来源类型：${renderSourceType(entry.sourceType)}`,
		`- 错误：${renderMaybe(entry.errorMessage)}`,
		"",
		"## 结果",
		"",
		`- 标题：${renderMaybe(entry.title)}`,
		`- AI 整理笔记路径：${renderMaybe(entry.notePath)}`,
		`- 原文笔记路径：${renderMaybe(entry.originalNotePath)}`,
	].join("\n");
}
