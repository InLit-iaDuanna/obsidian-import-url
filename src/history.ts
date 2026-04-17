import {ImportHistoryEntry} from "./types";

export const MAX_RECENT_IMPORTS = 40;

export interface ImportHistoryGroup {
	label: string;
	entries: ImportHistoryEntry[];
}

function isValidDateString(value: string): boolean {
	return !Number.isNaN(new Date(value).getTime());
}

function sortRecent(entries: ImportHistoryEntry[]): ImportHistoryEntry[] {
	return [...entries].sort((left, right) => {
		return new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime();
	});
}

export function normalizeRecentImports(entries: unknown): ImportHistoryEntry[] {
	if (!Array.isArray(entries)) {
		return [];
	}

	const normalized: ImportHistoryEntry[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.id !== "string"
			|| typeof candidate.url !== "string"
			|| typeof candidate.host !== "string"
			|| typeof candidate.model !== "string"
			|| typeof candidate.submittedAt !== "string"
			|| !isValidDateString(candidate.submittedAt)
			|| (candidate.status !== "processing" && candidate.status !== "complete" && candidate.status !== "failed")
		) {
			continue;
		}

		normalized.push({
				id: candidate.id,
				url: candidate.url,
				host: candidate.host,
				apiBaseUrl: typeof candidate.apiBaseUrl === "string" ? candidate.apiBaseUrl : "https://api.openai.com/v1",
				model: candidate.model,
				submittedAt: candidate.submittedAt,
				status: candidate.status,
				progressStage: candidate.progressStage === "queued"
					|| candidate.progressStage === "preflight"
					|| candidate.progressStage === "fetching"
					|| candidate.progressStage === "extracting"
					|| candidate.progressStage === "ai_call"
					|| candidate.progressStage === "saving"
					|| candidate.progressStage === "complete"
					|| candidate.progressStage === "failed"
					? candidate.progressStage
					: candidate.status === "complete"
						? "complete"
						: candidate.status === "failed"
							? "failed"
							: "queued",
				progressPercent: typeof candidate.progressPercent === "number"
					? Math.max(0, Math.min(100, candidate.progressPercent))
					: candidate.status === "complete"
						? 100
						: 0,
				progressMessage: typeof candidate.progressMessage === "string"
					? candidate.progressMessage
					: candidate.status === "complete"
						? "Import complete"
						: candidate.status === "failed"
							? "Import failed"
							: "Queued",
				progressUpdatedAt: typeof candidate.progressUpdatedAt === "string" && isValidDateString(candidate.progressUpdatedAt)
					? candidate.progressUpdatedAt
					: candidate.submittedAt,
				title: typeof candidate.title === "string" ? candidate.title : undefined,
				notePath: typeof candidate.notePath === "string" ? candidate.notePath : undefined,
				historyNotePath: typeof candidate.historyNotePath === "string" ? candidate.historyNotePath : undefined,
				sourceType: candidate.sourceType === "webpage" || candidate.sourceType === "pdf" ? candidate.sourceType : undefined,
				errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
			});
		}

	return sortRecent(normalized).slice(0, MAX_RECENT_IMPORTS);
}

export function upsertRecentImport(entries: ImportHistoryEntry[], nextEntry: ImportHistoryEntry): ImportHistoryEntry[] {
	const filtered = entries.filter((entry) => entry.id !== nextEntry.id);
	return sortRecent([nextEntry, ...filtered]).slice(0, MAX_RECENT_IMPORTS);
}

export function updateRecentImport(
	entries: ImportHistoryEntry[],
	id: string,
	mutate: (entry: ImportHistoryEntry) => ImportHistoryEntry,
): ImportHistoryEntry[] {
	return normalizeRecentImports(entries.map((entry) => {
		return entry.id === id ? mutate(entry) : entry;
	}));
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayDiff(now: Date, target: Date): number {
	const current = startOfDay(now).getTime();
	const other = startOfDay(target).getTime();
	return Math.floor((current - other) / (24 * 60 * 60 * 1000));
}

export function groupRecentImports(entries: ImportHistoryEntry[], now: Date = new Date()): ImportHistoryGroup[] {
	const todayGroup: ImportHistoryGroup = {label: "Today", entries: []};
	const yesterdayGroup: ImportHistoryGroup = {label: "Yesterday", entries: []};
	const weekGroup: ImportHistoryGroup = {label: "Last 7 days", entries: []};
	const olderGroup: ImportHistoryGroup = {label: "Older", entries: []};
	const groups: ImportHistoryGroup[] = [todayGroup, yesterdayGroup, weekGroup, olderGroup];

	for (const entry of sortRecent(entries)) {
		const diff = dayDiff(now, new Date(entry.submittedAt));
		if (diff <= 0) {
			todayGroup.entries.push(entry);
		} else if (diff === 1) {
			yesterdayGroup.entries.push(entry);
		} else if (diff < 7) {
			weekGroup.entries.push(entry);
		} else {
			olderGroup.entries.push(entry);
		}
	}

	return groups.filter((group) => group.entries.length > 0);
}
