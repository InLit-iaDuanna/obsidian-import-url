import {ImportHistoryEntry} from "../types";
import {formatFileTimestamp, sanitizeNoteTitle} from "./notes";

function quoteYaml(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function renderMaybe(value: string | undefined): string {
	return value?.trim() || "无";
}

export function buildHistoryFileName(host: string, suffix: string, date: Date): string {
	return `${formatFileTimestamp(date)} - Import History - ${sanitizeNoteTitle(host) || "source"} - ${suffix}.md`;
}

export function renderHistoryNote(entry: ImportHistoryEntry): string {
	return [
		"---",
		"type: 'import_url_history'",
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
		"---",
		"",
		"# Import URL Record",
		"",
		"## Request",
		"",
		`- URL: ${entry.url}`,
		`- Host: ${entry.host}`,
		`- API Base URL: ${entry.apiBaseUrl}`,
		`- Model: ${entry.model}`,
		`- Submitted At: ${entry.submittedAt}`,
		"",
		"## Progress",
		"",
		`- Progress: ${entry.progressPercent}%`,
		`- Stage: ${entry.progressStage}`,
		`- Message: ${entry.progressMessage}`,
		`- Updated At: ${entry.progressUpdatedAt}`,
		"",
		"## Status",
		"",
		`- Current Status: ${entry.status}`,
		`- Source Type: ${renderMaybe(entry.sourceType)}`,
		`- Error: ${renderMaybe(entry.errorMessage)}`,
		"",
		"## Result",
		"",
		`- Title: ${renderMaybe(entry.title)}`,
		`- Final Note Path: ${renderMaybe(entry.notePath)}`,
	].join("\n");
}
