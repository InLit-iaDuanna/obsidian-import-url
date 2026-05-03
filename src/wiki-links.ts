import {WikiConceptDraft} from "./types";

const MAX_WIKI_TITLE_LENGTH = 80;
const CJK_PATTERN = /[\u3400-\u9fff]/u;
const ASCII_LETTER_PATTERN = /[a-z]/iu;
const HASH_LIKE_PATTERN = /^[a-f0-9]{8,}$/iu;
const MOSTLY_SYMBOL_OR_NUMBER_PATTERN = /^[\d\s._-]+$/u;
const GENERIC_TITLE_PATTERN = /^(未命名\s*\d*|untitled\s*\d*|unknown\s*\d*|无|none|null|n\/a)$/iu;
const GENERIC_ONE_CHAR_PATTERN = /^[也了的是和与及或在为对把被就都而及其这那一二三四五六七八九十]$/u;

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		result.push(trimmed);
	}

	return result;
}

export function sanitizeWikiTitle(value: string): string {
	return value
		.split("")
		.map((char) => char.charCodeAt(0) < 32 ? " " : char)
		.join("")
		.replace(/[[\]\\|#^]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, MAX_WIKI_TITLE_LENGTH)
		.trim();
}

export function isSafeWikiTitle(value: string): boolean {
	const title = sanitizeWikiTitle(value);
	const compactTitle = title.replace(/\s+/gu, "");
	return !!title
		&& title.length <= MAX_WIKI_TITLE_LENGTH
		&& (CJK_PATTERN.test(title) || ASCII_LETTER_PATTERN.test(title))
		&& !GENERIC_TITLE_PATTERN.test(title)
		&& !HASH_LIKE_PATTERN.test(compactTitle)
		&& !MOSTLY_SYMBOL_OR_NUMBER_PATTERN.test(title)
		&& !(compactTitle.length <= 1)
		&& !(compactTitle.length === 2 && /^[a-z0-9]+$/iu.test(compactTitle))
		&& !GENERIC_ONE_CHAR_PATTERN.test(compactTitle)
		&& !/^https?:\/\//iu.test(title)
		&& !/[。！？.!?]\s*$/u.test(title)
		&& title.split(/\s+/u).length <= 10;
}

function isRelatedConceptAllowed(title: string, sourceTitle: string): boolean {
	const safeTitle = sanitizeWikiTitle(title);
	return isSafeWikiTitle(safeTitle) && safeTitle.toLowerCase() !== sourceTitle.toLowerCase();
}

export function normalizeConceptDrafts(concepts: WikiConceptDraft[] | undefined): WikiConceptDraft[] {
	const normalized: WikiConceptDraft[] = [];
	const seen = new Set<string>();

	for (const concept of concepts ?? []) {
		const title = sanitizeWikiTitle(concept.title);
		if (!isSafeWikiTitle(title)) {
			continue;
		}

		const key = title.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const relatedConcepts = uniqueStrings((concept.relatedConcepts ?? []).map(sanitizeWikiTitle))
			.filter((relatedTitle) => isRelatedConceptAllowed(relatedTitle, title));

		normalized.push({
			title,
			aliases: uniqueStrings((concept.aliases ?? []).map(sanitizeWikiTitle)).filter(isSafeWikiTitle),
			summary: concept.summary.trim(),
			evidence: uniqueStrings(concept.evidence ?? []),
			relatedConcepts,
			confidence: Math.max(0, Math.min(1, Number.isFinite(concept.confidence) ? concept.confidence : 0)),
		});
	}

	return normalized;
}

export function conceptToWikiLink(conceptsFolder: string, title: string): string {
	const safeTitle = sanitizeWikiTitle(title);
	if (!isSafeWikiTitle(safeTitle)) {
		return safeTitle;
	}

	const normalizedFolder = conceptsFolder.replace(/\/+$/u, "");
	return `[[${normalizedFolder}/${safeTitle}|${safeTitle}]]`;
}

export function renderConceptLinkList(conceptsFolder: string, concepts: WikiConceptDraft[] | undefined): string {
	const normalized = normalizeConceptDrafts(concepts);
	if (normalized.length === 0) {
		return "- 无";
	}

	return normalized.map((concept) => `- ${conceptToWikiLink(conceptsFolder, concept.title)} - ${concept.summary || "无摘要"}`).join("\n");
}

export function renderConceptDraftList(concepts: WikiConceptDraft[] | undefined): string {
	const normalized = normalizeConceptDrafts(concepts);
	if (normalized.length === 0) {
		return "- 无";
	}

	return normalized.map((concept) => `- ${concept.title} - ${concept.summary || "无摘要"}`).join("\n");
}
