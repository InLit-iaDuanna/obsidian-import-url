import {App} from "obsidian";

export type GraphColorTone = "concept" | "candidate" | "article" | "original" | "status" | "own";

export interface GraphColorRule {
	label: string;
	query: string;
	description: string;
	tone: GraphColorTone;
	color: string;
	copyable: boolean;
}

export interface ApplyGraphColorGroupsResult {
	graphPath: string;
	added: number;
	updated: number;
	unchanged: number;
	total: number;
	preserved: number;
}

interface GraphColorValue {
	a: number;
	rgb: number;
}

interface GraphColorGroup {
	query: string;
	color: GraphColorValue;
}

type JsonRecord = Record<string, unknown>;

export const IMPORT_URL_GRAPH_COLOR_RULES: GraphColorRule[] = [
	{
		label: "已入库概念",
		query: "tag:#import-url/concept",
		description: "正式概念页，使用醒目的绿色。",
		tone: "concept",
		color: "#2fb344",
		copyable: true,
	},
	{
		label: "待入库候选",
		query: "tag:#import-url/candidate",
		description: "还没有批准的候选概念，使用黄色和正式概念分开。",
		tone: "candidate",
		color: "#d99f00",
		copyable: true,
	},
	{
		label: "AI 整理成文",
		query: "tag:#import-url/article",
		description: "模型整理后的结构化知识库笔记，使用蓝色。",
		tone: "article",
		color: "#4c8df6",
		copyable: true,
	},
	{
		label: "原文",
		query: "tag:#import-url/original",
		description: "抓取到的网页或 PDF 原文笔记，使用低饱和灰色。",
		tone: "original",
		color: "#8a8f98",
		copyable: true,
	},
	{
		label: "来源和状态",
		query: "tag:#import-url/source OR tag:#import-url/history OR tag:#import-url/processing OR tag:#import-url/failed OR tag:#import-url/index",
		description: "来源记录、导入历史、处理中和失败记录，使用红色。",
		tone: "status",
		color: "#e05252",
		copyable: true,
	},
	{
		label: "我的手写文件",
		query: "-tag:#import-url/generated",
		description: "没有 import-url 生成标签的文件，使用紫色，和插件生成内容分开。",
		tone: "own",
		color: "#8b5cf6",
		copyable: true,
	},
];

const GRAPH_CONFIG_FILE = "graph.json";
const DEFAULT_CONFIG_DIR = [".", "obsidian"].join("");

export async function applyImportUrlGraphColorGroups(app: App): Promise<ApplyGraphColorGroupsResult> {
	const vault = app.vault as App["vault"] & {configDir?: string};
	const adapter = vault.adapter;
	const graphPath = joinVaultPath(vault.configDir || DEFAULT_CONFIG_DIR, GRAPH_CONFIG_FILE);
	const config = await readGraphConfig(adapter, graphPath);
	const existingGroups = getExistingColorGroups(config);
	const ruleQueries = new Set(IMPORT_URL_GRAPH_COLOR_RULES.map((rule) => rule.query));
	const preservedGroups = existingGroups.filter((group) => !isImportUrlGraphColorGroup(group, ruleQueries));
	let added = 0;
	let updated = 0;
	let unchanged = 0;

	for (const rule of IMPORT_URL_GRAPH_COLOR_RULES) {
		const existing = existingGroups.find((group) => getGroupQuery(group) === rule.query);
		const next = renderGraphColorGroup(rule);
		if (!existing) {
			added += 1;
		} else if (sameGraphColorGroup(existing, next)) {
			unchanged += 1;
		} else {
			updated += 1;
		}
	}

	config["collapse-color-groups"] = false;
	config.colorGroups = [
		...preservedGroups,
		...IMPORT_URL_GRAPH_COLOR_RULES.map(renderGraphColorGroup),
	];

	await adapter.write(graphPath, `${JSON.stringify(config, null, "\t")}\n`);
	return {
		graphPath,
		added,
		updated,
		unchanged,
		total: IMPORT_URL_GRAPH_COLOR_RULES.length,
		preserved: preservedGroups.length,
	};
}

function joinVaultPath(folder: string, fileName: string): string {
	return `${folder.replace(/\/+$/u, "")}/${fileName}`.replace(/\/+/gu, "/");
}

async function readGraphConfig(adapter: App["vault"]["adapter"], graphPath: string): Promise<JsonRecord> {
	try {
		const exists = await adapter.exists(graphPath);
		if (!exists) {
			return {};
		}

		const content = await adapter.read(graphPath);
		if (!content.trim()) {
			return {};
		}

		const parsed = JSON.parse(content) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`无法读取或解析 Obsidian 图谱配置：${message}`);
	}
}

function getExistingColorGroups(config: JsonRecord): JsonRecord[] {
	return Array.isArray(config.colorGroups)
		? config.colorGroups.filter(isRecord)
		: [];
}

function isImportUrlGraphColorGroup(group: JsonRecord, ruleQueries: Set<string>): boolean {
	const query = getGroupQuery(group);
	return query !== null && ruleQueries.has(query);
}

function getGroupQuery(group: JsonRecord): string | null {
	return typeof group.query === "string" ? group.query : null;
}

function renderGraphColorGroup(rule: GraphColorRule): GraphColorGroup {
	return {
		query: rule.query,
		color: {
			a: 1,
			rgb: parseColor(rule.color),
		},
	};
}

function sameGraphColorGroup(existing: JsonRecord, expected: GraphColorGroup): boolean {
	const color = isRecord(existing.color) ? existing.color : {};
	return existing.query === expected.query
		&& color.a === expected.color.a
		&& color.rgb === expected.color.rgb;
}

function parseColor(hexColor: string): number {
	return Number.parseInt(hexColor.replace(/^#/u, ""), 16);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
