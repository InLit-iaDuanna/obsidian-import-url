import {App, Notice, TFile} from "obsidian";
import {ImportUrlPluginSettings, SourceType, StructuredDigest, WikiConceptDraft} from "./types";
import {isSafeWikiTitle, normalizeConceptDrafts, sanitizeWikiTitle} from "./wiki-links";
import {formatClippedAt, formatFileTimestamp, randomHexSuffix, sanitizeNoteTitle} from "./render/notes";

interface WikiArtifactInput {
	sourceUrl: string;
	sourceType: SourceType;
	sourceTitle: string;
	notePath: string;
	digest: StructuredDigest;
	model: string;
	date: Date;
	suffix: string;
}

interface CandidateFrontmatter {
	concept: string;
	sourceUrl: string;
	sourceNotePath: string;
	model: string;
	generatedAt: string;
	confidence: string;
}

interface ConceptFrontmatter {
	title: string;
	createdAt: string;
	updatedAt: string;
	graphVisible: boolean;
}

interface PendingCandidateIndexItem {
	path: string;
	concept: string;
	generatedAt: string;
	confidence: string;
}

export type WikiConceptSortMode = "initial" | "imported" | "links";

export interface WikiCandidateOverview {
	path: string;
	title: string;
	generatedAt: string;
	confidence: string;
	sourceUrl: string;
	sourceNotePath: string;
	targetConceptPath: string;
	targetConceptExists: boolean;
	linkCount: number;
}

export interface WikiConceptOverview {
	path: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	graphVisible: boolean;
	linkCount: number;
}

interface ConceptRelation {
	title: string;
	path: string;
}

export interface WikiOverview {
	candidates: WikiCandidateOverview[];
	concepts: WikiConceptOverview[];
}

function quoteYaml(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function renderYamlTags(tags: string[]): string[] {
	return [
		"tags:",
		...tags.map((tag) => `  - ${quoteYaml(tag)}`),
	];
}

function joinVaultPath(folder: string, fileName: string): string {
	return `${folder.replace(/\/+$/u, "")}/${fileName}`;
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const segments = folderPath.split("/").filter(Boolean);
	let currentPath = "";

	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(currentPath);
		if (!existing) {
			await app.vault.createFolder(currentPath);
		}
	}
}

async function ensureParentFolder(app: App, filePath: string): Promise<void> {
	const folder = filePath.split("/").slice(0, -1).join("/");
	if (folder) {
		await ensureFolder(app, folder);
	}
}

async function readFile(app: App, file: TFile): Promise<string> {
	const vault = app.vault as typeof app.vault & {
		cachedRead?: (file: TFile) => Promise<string>;
		read?: (file: TFile) => Promise<string>;
	};

	if (typeof vault.cachedRead === "function") {
		return vault.cachedRead(file);
	}
	if (typeof vault.read === "function") {
		return vault.read(file);
	}
	return "";
}

async function resolveUniquePath(app: App, folder: string, fileName: string, suffix: string): Promise<string> {
	await ensureFolder(app, folder);
	let candidate = joinVaultPath(folder, fileName);

	if (!app.vault.getAbstractFileByPath(candidate)) {
		return candidate;
	}

	const extension = ".md";
	const stem = candidate.endsWith(extension) ? candidate.slice(0, -extension.length) : candidate;
	candidate = `${stem} - ${suffix}${extension}`;

	if (!app.vault.getAbstractFileByPath(candidate)) {
		return candidate;
	}

	let counter = 2;
	while (app.vault.getAbstractFileByPath(`${stem} - ${suffix}-${counter}${extension}`)) {
		counter += 1;
	}

	return `${stem} - ${suffix}-${counter}${extension}`;
}

function noteLink(path: string, label: string): string {
	return `[[${path.replace(/\.md$/iu, "")}|${label}]]`;
}

function renderList(items: string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- 无";
}

function renderSourceType(sourceType: SourceType): string {
	return sourceType === "pdf" ? "PDF" : "网页";
}

function renderSourceRecord(input: WikiArtifactInput): string {
	return [
		"---",
		"kind: 'wiki-source'",
		"graph_group: 'import-url-wiki-source'",
		...renderYamlTags(["import-url/source", "import-url/generated"]),
		`source_url: ${quoteYaml(input.sourceUrl)}`,
		`source_type: ${quoteYaml(input.sourceType)}`,
		`source_title: ${quoteYaml(input.sourceTitle)}`,
		`result_note: ${quoteYaml(input.notePath)}`,
		`model: ${quoteYaml(input.model)}`,
		`generated_at: ${quoteYaml(formatClippedAt(input.date))}`,
		"---",
		"",
		`# 来源 - ${input.digest.title || input.sourceTitle}`,
		"",
		`- 结果笔记路径：${input.notePath}`,
		`- 原始 URL：${input.sourceUrl}`,
		`- 来源类型：${renderSourceType(input.sourceType)}`,
		`- 模型：${input.model}`,
		"",
		"## 摘要",
		"",
		input.digest.summary || "无",
		"",
		"## 概念",
		"",
		renderList(normalizeConceptDrafts(input.digest.concepts).map((concept) => concept.title)),
	].join("\n");
}

function renderCandidateNote(input: WikiArtifactInput, concept: WikiConceptDraft): string {
	return [
		"---",
		"kind: 'wiki-candidate'",
		"status: 'pending'",
		"graph_group: 'import-url-wiki-candidate'",
		...renderYamlTags(["import-url/candidate", "import-url/generated"]),
		`concept: ${quoteYaml(concept.title)}`,
		`sourceUrl: ${quoteYaml(input.sourceUrl)}`,
		`sourceNotePath: ${quoteYaml(input.notePath)}`,
		`model: ${quoteYaml(input.model)}`,
		`generatedAt: ${quoteYaml(formatClippedAt(input.date))}`,
		`confidence: ${concept.confidence}`,
		"---",
		"",
		`# ${concept.title}`,
		"",
		"## 摘要",
		"",
		concept.summary || "无",
		"",
		"## 证据",
		"",
		renderList(concept.evidence),
		"",
		"## 别名",
		"",
		renderList(concept.aliases),
		"",
		"## 相关概念",
		"",
		renderList(concept.relatedConcepts),
		"",
		"## 来源",
		"",
		`- 结果笔记路径：${input.notePath}`,
		`- 原始 URL：${input.sourceUrl}`,
		`- 模型：${input.model}`,
	].join("\n");
}

function parseFrontmatter(content: string): Record<string, string> | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/u);
	if (!match) {
		return null;
	}

	const result: Record<string, string> = {};
	for (const rawLine of match[1]!.split(/\r?\n/u)) {
		const separator = rawLine.indexOf(":");
		if (separator === -1) {
			continue;
		}

		const key = rawLine.slice(0, separator).trim();
		const rawValue = rawLine.slice(separator + 1).trim();
		result[key] = rawValue.replace(/^'(.*)'$/u, "$1").replace(/''/gu, "'");
	}

	return result;
}

function updateCandidateStatus(content: string, status: "approved" | "rejected"): string {
	if (/^status:\s*'pending'$/imu.test(content)) {
		return content.replace(/^status:\s*'pending'$/imu, `status: '${status}'`);
	}

	return content.replace(/^---\n/u, `---\nstatus: '${status}'\n`);
}

function extractCandidateBody(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n?/u, "").trim();
}

function renderConceptPage(frontmatter: CandidateFrontmatter, candidateBody: string, now: Date, graphVisible: boolean): string {
	const concept = sanitizeWikiTitle(frontmatter.concept);
	return [
		"---",
		"kind: 'wiki-concept'",
		"graph_group: 'import-url-concept'",
		...renderYamlTags(["import-url/concept", "import-url/generated"]),
		`title: ${quoteYaml(concept)}`,
		`created_at: ${quoteYaml(frontmatter.generatedAt || formatClippedAt(now))}`,
		`updated_at: ${quoteYaml(formatClippedAt(now))}`,
		`graph: ${quoteYaml(graphVisible ? "show" : "hide")}`,
		"---",
		"",
		`# ${concept}`,
		"",
		"## 当前摘要",
		"",
		candidateBody,
		"",
		"## 真实关联",
		"",
		"- 无",
		"",
		"## 来源更新",
		"",
		renderConceptUpdate(frontmatter, candidateBody),
	].join("\n");
}

function renderConceptUpdate(frontmatter: CandidateFrontmatter, candidateBody: string): string {
	return [
		`### ${frontmatter.generatedAt || new Date().toISOString()}`,
		"",
		`- 来源笔记路径：${frontmatter.sourceNotePath}`,
		`- 来源 URL：${frontmatter.sourceUrl}`,
		`- 模型：${frontmatter.model}`,
		`- 置信度：${frontmatter.confidence}`,
		"",
		candidateBody,
	].join("\n");
}

function parseCandidateFrontmatter(content: string): CandidateFrontmatter | null {
	const parsed = parseFrontmatter(content);
	if (!parsed || parsed.kind !== "wiki-candidate" || !parsed.concept || !parsed.sourceUrl || !parsed.sourceNotePath) {
		return null;
	}

	return {
		concept: parsed.concept,
		sourceUrl: parsed.sourceUrl,
		sourceNotePath: parsed.sourceNotePath,
		model: parsed.model ?? "",
		generatedAt: parsed.generatedAt ?? "",
		confidence: parsed.confidence ?? "",
	};
}

function parseConceptFrontmatter(content: string, fallbackTitle: string): ConceptFrontmatter | null {
	const parsed = parseFrontmatter(content);
	if (!parsed || parsed.kind !== "wiki-concept") {
		return null;
	}

	const title = sanitizeWikiTitle(parsed.title || fallbackTitle);
	if (!title) {
		return null;
	}

	return {
		title,
		createdAt: parsed.created_at ?? "",
		updatedAt: parsed.updated_at ?? "",
		graphVisible: parsed.graph !== "hide",
	};
}

function upsertFrontmatterField(content: string, key: string, value: string): string {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/u);
	if (!frontmatterMatch) {
		return `---\n${key}: ${value}\n---\n\n${content}`;
	}

	const frontmatter = frontmatterMatch[1] ?? "";
	const linePattern = new RegExp(`^${key}:.*$`, "mu");
	if (linePattern.test(frontmatter)) {
		return content.replace(linePattern, `${key}: ${value}`);
	}

	return content.replace(/^---\n/u, `---\n${key}: ${value}\n`);
}

function updateConceptFrontmatter(content: string, now: Date, graphVisible?: boolean): string {
	let nextContent = upsertFrontmatterField(content, "updated_at", quoteYaml(formatClippedAt(now)));
	nextContent = upsertFrontmatterField(nextContent, "graph_group", quoteYaml("import-url-concept"));
	if (graphVisible !== undefined) {
		nextContent = upsertFrontmatterField(nextContent, "graph", quoteYaml(graphVisible ? "show" : "hide"));
	} else if (!/^graph:/imu.test(nextContent)) {
		nextContent = upsertFrontmatterField(nextContent, "graph", quoteYaml("show"));
	}
	if (!/^tags:/imu.test(nextContent)) {
		nextContent = nextContent.replace(/^---\n/u, `---\n${renderYamlTags(["import-url/concept", "import-url/generated"]).join("\n")}\n`);
	}
	return nextContent;
}

function listMarkdownFiles(app: App): TFile[] {
	const vault = app.vault as typeof app.vault & {
		getMarkdownFiles?: () => TFile[];
		listFiles?: () => TFile[];
	};
	if (typeof vault.getMarkdownFiles === "function") {
		return vault.getMarkdownFiles();
	}
	if (typeof vault.listFiles === "function") {
		return vault.listFiles();
	}
	return [];
}

function stripMarkdownExtension(path: string): string {
	return path.replace(/\.md$/iu, "");
}

function getFileTitleFromPath(path: string): string {
	return stripMarkdownExtension(path).split("/").pop() ?? path;
}

function canonicalConceptKey(title: string): string {
	return sanitizeWikiTitle(title).toLowerCase();
}

function normalizeLinkTarget(rawTarget: string): string {
	const targetWithoutAlias = rawTarget.split("|")[0] ?? "";
	const targetWithoutHeading = targetWithoutAlias.split("#")[0] ?? "";
	return stripMarkdownExtension(targetWithoutHeading.trim()).toLowerCase();
}

function matchesConceptTarget(rawTarget: string, conceptPath: string, conceptTitle: string): boolean {
	const normalizedTarget = normalizeLinkTarget(rawTarget);
	const normalizedPath = stripMarkdownExtension(conceptPath).toLowerCase();
	const normalizedTitle = conceptTitle.toLowerCase();
	return normalizedTarget === normalizedPath
		|| normalizedTarget === normalizedTitle
		|| normalizedTarget.endsWith(`/${normalizedTitle}`);
}

function countConceptLinksInContent(content: string, conceptPath: string, conceptTitle: string): number {
	let count = 0;
	const wikilinkPattern = /\[\[([^\]\n]+)\]\]/gu;
	for (const match of content.matchAll(wikilinkPattern)) {
		if (matchesConceptTarget(match[1] ?? "", conceptPath, conceptTitle)) {
			count += 1;
		}
	}
	return count;
}

async function countConceptLinks(app: App, settings: ImportUrlPluginSettings, conceptPath: string, conceptTitle: string): Promise<number> {
	let count = 0;
	const excludedPaths = new Set([conceptPath, settings.wikiIndexPath]);
	for (const file of listMarkdownFiles(app)) {
		if (excludedPaths.has(file.path) || !file.path.endsWith(".md")) {
			continue;
		}
		count += countConceptLinksInContent(await readFile(app, file), conceptPath, conceptTitle);
	}
	return count;
}

function sortOverviewItems<T extends {title: string; linkCount: number} & ({generatedAt: string} | {createdAt: string})>(
	items: T[],
	sortMode: WikiConceptSortMode,
): T[] {
	return [...items].sort((a, b) => {
		if (sortMode === "links") {
			return b.linkCount - a.linkCount || a.title.localeCompare(b.title, "zh-Hans-u-co-pinyin", {sensitivity: "base"});
		}

		if (sortMode === "imported") {
			const aTime = Date.parse("generatedAt" in a ? a.generatedAt : a.createdAt);
			const bTime = Date.parse("generatedAt" in b ? b.generatedAt : b.createdAt);
			return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
				|| a.title.localeCompare(b.title, "zh-Hans-u-co-pinyin", {sensitivity: "base"});
		}

		return a.title.localeCompare(b.title, "zh-Hans-u-co-pinyin", {sensitivity: "base"})
			|| b.linkCount - a.linkCount;
	});
}

async function listPendingCandidateIndexItems(app: App, settings: ImportUrlPluginSettings): Promise<PendingCandidateIndexItem[]> {
	const candidatePrefix = `${settings.wikiCandidatesFolder.replace(/\/+$/u, "")}/`;
	const rejectedPrefix = `${joinVaultPath(settings.wikiCandidatesFolder, "已拒绝").replace(/\/+$/u, "")}/`;
	const files = listMarkdownFiles(app)
		.filter((file) => file.path.startsWith(candidatePrefix) && !file.path.startsWith(rejectedPrefix) && file.path.endsWith(".md"))
		.sort((a, b) => a.path.localeCompare(b.path));
	const items: PendingCandidateIndexItem[] = [];

	for (const file of files) {
		const frontmatter = parseFrontmatter(await readFile(app, file));
		if (frontmatter?.kind !== "wiki-candidate" || frontmatter.status !== "pending") {
			continue;
		}

		items.push({
			path: file.path,
			concept: frontmatter.concept || "未知概念",
			generatedAt: frontmatter.generatedAt || "未知时间",
			confidence: frontmatter.confidence || "未知",
		});
	}

	return items;
}

function renderPendingCandidateList(items: PendingCandidateIndexItem[]): string {
	if (items.length === 0) {
		return "- 无";
	}

	return items
		.map((item) => `- ${item.concept} · 候选页：${item.path} · 置信度：${item.confidence} · 生成时间：${item.generatedAt}`)
		.join("\n");
}

function renderConceptIndexList(items: WikiConceptOverview[]): string {
	if (items.length === 0) {
		return "- 无";
	}

	return items.map((item) => {
		const display = `${item.title}（${item.path}）`;
		const graphStatus = item.graphVisible ? "图谱：展示" : "图谱：隐藏";
		return `- ${display} · ${graphStatus} · 链接次数：${item.linkCount}`;
	}).join("\n");
}

function isManagedOutputNote(path: string, settings: ImportUrlPluginSettings): boolean {
	const outputPrefixes = [
		`${settings.outputFolder.replace(/\/+$/u, "")}/`,
		`${settings.originalFolder.replace(/\/+$/u, "")}/`,
	];
	const excludedPrefixes = [
		settings.wikiFolder,
		settings.processingFolder,
		settings.failedFolder,
		settings.historyFolder,
	].map((folder) => `${folder.replace(/\/+$/u, "")}/`);
	return outputPrefixes.some((prefix) => path.startsWith(prefix))
		&& path.endsWith(".md")
		&& !excludedPrefixes.some((prefix) => path.startsWith(prefix));
}

function plainConceptLine(line: string): string {
	return line.replace(/\[\[([^\]\n]+)\]\]/gu, (_match: string, rawTarget: string) => {
		const target = rawTarget.split("|").pop() || rawTarget;
		return sanitizeWikiTitle(target.split("#")[0] || target) || target;
	});
}

function rewriteLegacyConceptLinks(content: string, settings: ImportUrlPluginSettings): string {
	const normalizedConceptsFolder = settings.wikiConceptsFolder.replace(/\/+$/u, "");
	if (!content.includes(`[[${normalizedConceptsFolder}/`)) {
		return content;
	}

	return content.replace(/## 相关概念\n\n([\s\S]*?)(?=\n# |\n## |$)/u, (_match: string, legacySection: string) => {
		const plainLines = legacySection
			.split(/\r?\n/u)
			.map(plainConceptLine)
			.join("\n")
			.trim();
		return [
			"## 待入库概念",
			"",
			"以下概念仅作为候选进入知识库管理，批准前不会写入正式概念图谱。",
			"",
			plainLines || "- 无",
		].join("\n");
	});
}

function stripAllWikilinks(content: string): string {
	return content.replace(/\[\[([^\]\n]+)\]\]/gu, (_match: string, rawTarget: string) => {
		const display = rawTarget.split("|").pop() || rawTarget;
		return sanitizeWikiTitle(display.split("#")[0] || display) || display;
	});
}

function isManagedArtifact(path: string, settings: ImportUrlPluginSettings): boolean {
	return path === settings.wikiIndexPath
		|| path.startsWith(`${settings.wikiSourcesFolder.replace(/\/+$/u, "")}/`)
		|| path.startsWith(`${settings.wikiCandidatesFolder.replace(/\/+$/u, "")}/`)
		|| path.startsWith(`${settings.historyFolder.replace(/\/+$/u, "")}/`)
		|| path.startsWith(`${settings.processingFolder.replace(/\/+$/u, "")}/`)
		|| path.startsWith(`${settings.failedFolder.replace(/\/+$/u, "")}/`)
		|| isManagedOutputNote(path, settings);
}

function replaceOrInsertSection(content: string, heading: string, body: string): string {
	const sectionPattern = new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |\\n# |$)`, "mu");
	if (sectionPattern.test(content)) {
		return content.replace(sectionPattern, `$1${body.trimEnd()}\n`);
	}

	return `${content.trimEnd()}\n\n## ${heading}\n\n${body.trimEnd()}\n`;
}

async function buildApprovedConceptMaps(app: App, conceptFiles: TFile[]): Promise<Map<string, ConceptRelation>> {
	const conceptMap = new Map<string, ConceptRelation>();
	for (const file of conceptFiles) {
		const content = await readFile(app, file);
		const frontmatter = parseConceptFrontmatter(content, getFileTitleFromPath(file.path));
		if (!frontmatter || !isSafeWikiTitle(frontmatter.title)) {
			continue;
		}
		conceptMap.set(canonicalConceptKey(frontmatter.title), {title: frontmatter.title, path: file.path});
	}
	return conceptMap;
}

async function listApprovedConceptFiles(app: App, settings: ImportUrlPluginSettings): Promise<TFile[]> {
	const conceptPrefix = `${settings.wikiConceptsFolder.replace(/\/+$/u, "")}/`;
	const result: TFile[] = [];
	for (const file of listMarkdownFiles(app)) {
		if (!file.path.startsWith(conceptPrefix) || !file.path.endsWith(".md")) {
			continue;
		}
		const content = await readFile(app, file);
		const frontmatter = parseConceptFrontmatter(content, getFileTitleFromPath(file.path));
		if (frontmatter?.graphVisible && isSafeWikiTitle(frontmatter.title)) {
			result.push(file);
		}
	}
	return result;
}

function extractExplicitRelatedConceptTitles(content: string): string[] {
	const titles: string[] = [];
	const sectionPattern = /(?:^|\n)## 相关概念\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/gu;

	for (const section of content.matchAll(sectionPattern)) {
		const body = section[1] ?? "";
		for (const rawLine of body.split(/\r?\n/u)) {
			const line = rawLine.replace(/^[-*]\s*/u, "").trim();
			if (!line || line === "无") {
				continue;
			}
			const title = sanitizeWikiTitle(line.split(/[：:，,；;|]/u)[0] ?? line);
			if (isSafeWikiTitle(title)) {
				titles.push(title);
			}
		}
	}

	return [...new Set(titles.map((title) => canonicalConceptKey(title)))]
		.map((key) => titles.find((title) => canonicalConceptKey(title) === key) ?? key);
}

function inferRelationsFromExplicitRelatedConcepts(
	content: string,
	selfTitle: string,
	conceptMap: Map<string, ConceptRelation>,
): ConceptRelation[] {
	const relations: ConceptRelation[] = [];
	const selfKey = canonicalConceptKey(selfTitle);
	for (const relatedTitle of extractExplicitRelatedConceptTitles(content)) {
		const key = canonicalConceptKey(relatedTitle);
		if (key === selfKey) {
			continue;
		}
		const relation = conceptMap.get(key);
		if (relation) {
			relations.push(relation);
		}
	}
	return relations.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-u-co-pinyin", {sensitivity: "base"}));
}

function renderRealRelations(relations: ConceptRelation[]): string {
	if (relations.length === 0) {
		return "- 无";
	}

	return relations.map((relation) => `- ${noteLink(relation.path, relation.title)}`).join("\n");
}

async function refreshApprovedConceptRelations(app: App, settings: ImportUrlPluginSettings): Promise<number> {
	const conceptFiles = await listApprovedConceptFiles(app, settings);
	const conceptMap = await buildApprovedConceptMaps(app, conceptFiles);
	let updatedConcepts = 0;
	for (const file of conceptFiles) {
		const content = await readFile(app, file);
		const frontmatter = parseConceptFrontmatter(content, getFileTitleFromPath(file.path));
		if (!frontmatter) {
			continue;
		}
		const plainContent = stripAllWikilinks(content);
		const relations = inferRelationsFromExplicitRelatedConcepts(plainContent, frontmatter.title, conceptMap);
		const nextContent = replaceOrInsertSection(
			updateConceptFrontmatter(plainContent, new Date()),
			"真实关联",
			renderRealRelations(relations),
		);
		if (nextContent !== content) {
			await app.vault.modify(file, nextContent);
			updatedConcepts += 1;
		}
	}
	return updatedConcepts;
}

export async function rebuildWikiConceptGraph(app: App, settings: ImportUrlPluginSettings): Promise<{cleanedFiles: number; updatedConcepts: number}> {
	let cleanedFiles = 0;
	for (const file of listMarkdownFiles(app)) {
		if (!isManagedArtifact(file.path, settings)) {
			continue;
		}

		const content = await readFile(app, file);
		const nextContent = stripAllWikilinks(content);
		if (nextContent !== content) {
			await app.vault.modify(file, nextContent);
			cleanedFiles += 1;
		}
	}

	const updatedConcepts = await refreshApprovedConceptRelations(app, settings);

	await refreshWikiIndex(app, settings);
	return {cleanedFiles, updatedConcepts};
}

export async function cleanupLegacyConceptGraphLinks(app: App, settings: ImportUrlPluginSettings): Promise<number> {
	let changedCount = 0;
	for (const file of listMarkdownFiles(app)) {
		if (!isManagedOutputNote(file.path, settings)) {
			continue;
		}

		const content = await readFile(app, file);
		const nextContent = rewriteLegacyConceptLinks(content, settings);
		if (nextContent === content) {
			continue;
		}

		await app.vault.modify(file, nextContent);
		changedCount += 1;
	}

	await refreshWikiIndex(app, settings);
	return changedCount;
}

export async function getWikiOverview(
	app: App,
	settings: ImportUrlPluginSettings,
	sortMode: WikiConceptSortMode = "initial",
): Promise<WikiOverview> {
	const candidatePrefix = `${settings.wikiCandidatesFolder.replace(/\/+$/u, "")}/`;
	const rejectedPrefix = `${joinVaultPath(settings.wikiCandidatesFolder, "已拒绝").replace(/\/+$/u, "")}/`;
	const conceptPrefix = `${settings.wikiConceptsFolder.replace(/\/+$/u, "")}/`;
	const candidates: WikiCandidateOverview[] = [];
	const concepts: WikiConceptOverview[] = [];

	for (const file of listMarkdownFiles(app)) {
		if (!file.path.endsWith(".md")) {
			continue;
		}

		if (file.path.startsWith(candidatePrefix) && !file.path.startsWith(rejectedPrefix)) {
			const content = await readFile(app, file);
			const frontmatter = parseCandidateFrontmatter(content);
			if (!frontmatter || parseFrontmatter(content)?.status !== "pending") {
				continue;
			}

			const title = sanitizeWikiTitle(frontmatter.concept) || "未知概念";
			const conceptPath = joinVaultPath(settings.wikiConceptsFolder, `${sanitizeNoteTitle(title) || "concept"}.md`);
			candidates.push({
				path: file.path,
				title,
				generatedAt: frontmatter.generatedAt,
				confidence: frontmatter.confidence,
				sourceUrl: frontmatter.sourceUrl,
				sourceNotePath: frontmatter.sourceNotePath,
				targetConceptPath: conceptPath,
				targetConceptExists: !!app.vault.getAbstractFileByPath(conceptPath),
				linkCount: await countConceptLinks(app, settings, conceptPath, title),
			});
			continue;
		}

		if (file.path.startsWith(conceptPrefix)) {
			const content = await readFile(app, file);
			const frontmatter = parseConceptFrontmatter(content, getFileTitleFromPath(file.path));
			if (!frontmatter) {
				continue;
			}

			concepts.push({
				path: file.path,
				title: frontmatter.title,
				createdAt: frontmatter.createdAt,
				updatedAt: frontmatter.updatedAt,
				graphVisible: frontmatter.graphVisible,
				linkCount: await countConceptLinks(app, settings, file.path, frontmatter.title),
			});
		}
	}

	return {
		candidates: sortOverviewItems(candidates, sortMode),
		concepts: sortOverviewItems(concepts, sortMode),
	};
}

export async function refreshWikiIndex(app: App, settings: ImportUrlPluginSettings): Promise<void> {
	await ensureParentFolder(app, settings.wikiIndexPath);
	const overview = await getWikiOverview(app, settings, "initial");
	const pendingCandidates = await listPendingCandidateIndexItems(app, settings);
	const lines = [
		"---",
		"kind: 'wiki-index'",
		`updated_at: ${quoteYaml(formatClippedAt(new Date()))}`,
		"---",
		"",
		"# 知识库索引",
		"",
		"## 已入库概念",
		"",
		renderConceptIndexList(overview.concepts),
		"",
		"## 待入库概念",
		"",
		renderPendingCandidateList(pendingCandidates),
	].join("\n");

	const existing = app.vault.getAbstractFileByPath(settings.wikiIndexPath) as TFile | null;
	if (existing) {
		await app.vault.modify(existing, lines);
	} else {
		await app.vault.create(settings.wikiIndexPath, lines);
	}
}

export async function writeWikiArtifacts(app: App, settings: ImportUrlPluginSettings, input: WikiArtifactInput): Promise<void> {
	await ensureFolder(app, settings.wikiSourcesFolder);
	await ensureFolder(app, settings.wikiCandidatesFolder);
	await ensureFolder(app, settings.wikiConceptsFolder);

	const sourcePath = await resolveUniquePath(
		app,
		settings.wikiSourcesFolder,
		`${formatFileTimestamp(input.date)} - ${sanitizeNoteTitle(input.digest.title || input.sourceTitle)}.md`,
		input.suffix,
	);
	await app.vault.create(sourcePath, renderSourceRecord(input));

	for (const concept of normalizeConceptDrafts(input.digest.concepts)) {
		const candidatePath = await resolveUniquePath(
			app,
			settings.wikiCandidatesFolder,
			`${formatFileTimestamp(input.date)} - ${sanitizeNoteTitle(concept.title) || "概念"}.md`,
			input.suffix,
		);
		await app.vault.create(candidatePath, renderCandidateNote(input, concept));
	}

	await refreshWikiIndex(app, settings);
}

export async function openWikiIndex(app: App, settings: ImportUrlPluginSettings): Promise<void> {
	await refreshWikiIndex(app, settings);
	const file = app.vault.getAbstractFileByPath(settings.wikiIndexPath) as TFile | null;
	if (!file) {
		new Notice("无法创建知识库索引。", 5000);
		return;
	}

	await app.workspace.getLeaf(true).openFile(file);
}

function getActiveFile(app: App): TFile | null {
	const workspace = app.workspace as typeof app.workspace & {
		getActiveFile?: () => TFile | null;
	};
	return workspace.getActiveFile?.() ?? null;
}

function getVaultFile(app: App, path: string): TFile | null {
	return app.vault.getAbstractFileByPath(path) as TFile | null;
}

export async function approveWikiCandidateByPath(
	app: App,
	settings: ImportUrlPluginSettings,
	candidatePath: string,
	options: {graphVisible?: boolean} = {},
): Promise<void> {
	const candidateFile = getVaultFile(app, candidatePath);
	if (!candidateFile) {
		new Notice("找不到这篇知识库候选页。", 5000);
		return;
	}

	const content = await readFile(app, candidateFile);
	const frontmatter = parseCandidateFrontmatter(content);
	if (!frontmatter) {
		new Notice("这篇笔记不是可批准的知识库候选页。", 5000);
		return;
	}

	const now = new Date();
	const graphVisible = options.graphVisible ?? true;
	await ensureFolder(app, settings.wikiConceptsFolder);
	const conceptTitle = sanitizeWikiTitle(frontmatter.concept);
	const conceptPath = joinVaultPath(settings.wikiConceptsFolder, `${sanitizeNoteTitle(conceptTitle) || "concept"}.md`);
	const candidateBody = extractCandidateBody(content);
	const existingConcept = app.vault.getAbstractFileByPath(conceptPath) as TFile | null;
	if (existingConcept) {
		const existingContent = await readFile(app, existingConcept);
		const nextContent = updateConceptFrontmatter(
			`${existingContent.trimEnd()}\n\n${renderConceptUpdate(frontmatter, candidateBody)}\n`,
			now,
			graphVisible,
		);
		await app.vault.modify(existingConcept, nextContent);
	} else {
		await app.vault.create(conceptPath, renderConceptPage(frontmatter, candidateBody, now, graphVisible));
	}

	await app.vault.modify(candidateFile, updateCandidateStatus(content, "approved"));
	await refreshApprovedConceptRelations(app, settings);
	await refreshWikiIndex(app, settings);
	new Notice(`已批准知识库候选概念：${conceptTitle}`, 4000);
}

export async function approveActiveWikiCandidate(app: App, settings: ImportUrlPluginSettings): Promise<void> {
	const activeFile = getActiveFile(app);
	if (!activeFile) {
		new Notice("请先打开一篇知识库候选页。", 4000);
		return;
	}

	await approveWikiCandidateByPath(app, settings, activeFile.path, {graphVisible: true});
}

export async function rejectWikiCandidateByPath(app: App, settings: ImportUrlPluginSettings, candidatePath: string): Promise<void> {
	const candidateFile = getVaultFile(app, candidatePath);
	if (!candidateFile) {
		new Notice("找不到这篇知识库候选页。", 5000);
		return;
	}

	const content = await readFile(app, candidateFile);
	const frontmatter = parseCandidateFrontmatter(content);
	if (!frontmatter) {
		new Notice("这篇笔记不是可拒绝的知识库候选页。", 5000);
		return;
	}

	const rejectedFolder = joinVaultPath(settings.wikiCandidatesFolder, "已拒绝");
	await ensureFolder(app, rejectedFolder);
	await app.vault.modify(candidateFile, updateCandidateStatus(content, "rejected"));
	const targetPath = await resolveUniquePath(
		app,
		rejectedFolder,
		candidateFile.path.split("/").pop() || `${sanitizeNoteTitle(frontmatter.concept) || "candidate"} - ${randomHexSuffix()}.md`,
		randomHexSuffix(),
	);
	await app.vault.rename(candidateFile, targetPath);
	await refreshWikiIndex(app, settings);
	new Notice(`已拒绝知识库候选概念：${frontmatter.concept}`, 4000);
}

export async function rejectActiveWikiCandidate(app: App, settings: ImportUrlPluginSettings): Promise<void> {
	const activeFile = getActiveFile(app);
	if (!activeFile) {
		new Notice("请先打开一篇知识库候选页。", 4000);
		return;
	}

	await rejectWikiCandidateByPath(app, settings, activeFile.path);
}

export async function setWikiConceptGraphVisibility(
	app: App,
	settings: ImportUrlPluginSettings,
	conceptPath: string,
	graphVisible: boolean,
): Promise<void> {
	const conceptFile = getVaultFile(app, conceptPath);
	if (!conceptFile) {
		new Notice("找不到这篇正式概念页。", 5000);
		return;
	}

	const content = await readFile(app, conceptFile);
	const frontmatter = parseConceptFrontmatter(content, getFileTitleFromPath(conceptPath));
	if (!frontmatter) {
		new Notice("这篇笔记不是正式概念页。", 5000);
		return;
	}

	await app.vault.modify(conceptFile, updateConceptFrontmatter(content, new Date(), graphVisible));
	await refreshApprovedConceptRelations(app, settings);
	await refreshWikiIndex(app, settings);
	new Notice(`${frontmatter.title} 已${graphVisible ? "展示到" : "从"}知识库图谱${graphVisible ? "" : "中隐藏"}。`, 3500);
}
