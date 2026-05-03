import {ItemView, Notice, WorkspaceLeaf} from "obsidian";
import {WikiCandidateOverview, WikiConceptOverview, WikiConceptSortMode, WikiOverview} from "./wiki-artifacts";

export const WIKI_MANAGER_VIEW_TYPE = "import-url-wiki-manager";

type WikiManagerPanel = "pending" | "approved";

interface GraphGroupRule {
	label: string;
	query: string;
	description: string;
	tone: "concept" | "candidate" | "article" | "original" | "status" | "own";
	copyable: boolean;
}

interface WikiManagerViewHandlers {
	loadOverview: (sortMode: WikiConceptSortMode) => Promise<WikiOverview>;
	approveCandidate: (path: string, graphVisible: boolean) => Promise<void>;
	rejectCandidate: (path: string) => Promise<void>;
	setConceptGraphVisibility: (path: string, graphVisible: boolean) => Promise<void>;
	cleanupLegacyGraphLinks: () => Promise<number>;
	rebuildConceptGraph: () => Promise<{cleanedFiles: number; updatedConcepts: number; taggedFiles: number}>;
	openPath: (path: string) => Promise<boolean>;
}

const SORT_OPTIONS: Array<{mode: WikiConceptSortMode; label: string}> = [
	{mode: "initial", label: "首字母"},
	{mode: "imported", label: "导入时间"},
	{mode: "links", label: "链接次数"},
];

const GRAPH_GROUP_RULES: GraphGroupRule[] = [
	{
		label: "已入库概念",
		query: "tag:#import-url/concept",
		description: "正式概念页。建议使用最醒目的颜色。",
		tone: "concept",
		copyable: true,
	},
	{
		label: "待入库候选",
		query: "tag:#import-url/candidate",
		description: "还没有批准的候选概念。建议和正式概念分开。",
		tone: "candidate",
		copyable: true,
	},
	{
		label: "AI 整理成文",
		query: "tag:#import-url/article",
		description: "模型整理后的结构化知识库笔记。",
		tone: "article",
		copyable: true,
	},
	{
		label: "原文",
		query: "tag:#import-url/original",
		description: "抓取到的网页或 PDF 原文笔记。建议使用低饱和颜色。",
		tone: "original",
		copyable: true,
	},
	{
		label: "来源和状态",
		query: "tag:#import-url/source OR tag:#import-url/history OR tag:#import-url/processing OR tag:#import-url/failed OR tag:#import-url/index",
		description: "来源记录、导入历史、处理中和失败记录。建议使用很淡的颜色或过滤掉。",
		tone: "status",
		copyable: true,
	},
	{
		label: "我的手写文件",
		query: "默认颜色",
		description: "插件不会给你的手写笔记加 import-url 标签；它们会自然保留 Obsidian 图谱默认颜色。",
		tone: "own",
		copyable: false,
	},
];

function formatDate(value: string): string {
	if (!value.trim()) {
		return "未知时间";
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}

	const pad = (numberValue: number) => String(numberValue).padStart(2, "0");
	return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function createButton(parentEl: HTMLElement, label: string, callback: () => Promise<void> | void, className = ""): HTMLButtonElement {
	const buttonEl = parentEl.createEl("button", {
		text: label,
		cls: `import-url-wiki-button ${className}`.trim(),
	});
	buttonEl.type = "button";
	buttonEl.addEventListener("click", () => {
		void callback();
	});
	return buttonEl;
}

async function writeClipboardText(value: string): Promise<boolean> {
	try {
		if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
			return false;
		}
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
}

function createMetric(parentEl: HTMLElement, label: string, value: string | number): void {
	const metricEl = parentEl.createDiv({cls: "import-url-wiki-metric"});
	metricEl.createEl("span", {cls: "import-url-wiki-metric-label", text: label});
	metricEl.createEl("strong", {text: String(value)});
}

function createMetaItem(parentEl: HTMLElement, label: string, value: string | number): void {
	const itemEl = parentEl.createDiv({cls: "import-url-wiki-meta-item"});
	itemEl.createEl("span", {text: label});
	itemEl.createEl("strong", {text: String(value)});
}

function createSwitch(parentEl: HTMLElement, label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
	const wrapperEl = parentEl.createEl("label", {cls: "import-url-wiki-switch"});
	const inputEl = wrapperEl.createEl("input");
	inputEl.type = "checkbox";
	inputEl.checked = checked;
	wrapperEl.createEl("span", {cls: "import-url-wiki-switch-track"});
	wrapperEl.createEl("span", {text: label});
	inputEl.addEventListener("change", () => onChange(inputEl.checked));
	return inputEl;
}

export class WikiManagerView extends ItemView {
	private activePanel: WikiManagerPanel = "pending";
	private sortMode: WikiConceptSortMode = "initial";
	private renderVersion = 0;
	private readonly candidateGraphDrafts = new Map<string, boolean>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly handlers: WikiManagerViewHandlers,
	) {
		super(leaf);
	}

	getViewType(): string {
		return WIKI_MANAGER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "知识库管理";
	}

	getIcon(): string {
		return "network";
	}

	async onOpen(): Promise<void> {
		this.addAction("refresh-cw", "刷新", () => {
			void this.render();
		});
		await this.render();
	}

	async onClose(): Promise<void> {}

	private async render(): Promise<void> {
		const version = ++this.renderVersion;
		this.contentEl.empty();
		this.contentEl.addClass("import-url-wiki-manager");

		const headerEl = this.contentEl.createDiv({cls: "import-url-wiki-header"});
		headerEl.createEl("h2", {text: "知识库管理"});
		headerEl.createDiv({
			cls: "import-url-wiki-help",
			text: "待入库是模型抽取后等待你审核的概念；已入库是批准后的正式概念。只有已入库且设置为展示的概念，才会通过插件索引进入图谱。",
		});

		const bodyEl = this.contentEl.createDiv({cls: "import-url-wiki-body"});
		bodyEl.createDiv({cls: "import-url-empty", text: "正在读取知识库文件..."});

		try {
			const overview = await this.handlers.loadOverview(this.sortMode);
			if (version !== this.renderVersion) {
				return;
			}

			bodyEl.empty();
			this.renderSummary(bodyEl, overview);
			this.renderGraphGroupGuide(bodyEl);
			this.renderPanelTabs(bodyEl, overview);
			this.renderSortBar(bodyEl);
			if (this.activePanel === "pending") {
				this.renderCandidateQueue(bodyEl, overview.candidates);
			} else {
				this.renderConceptLibrary(bodyEl, overview.concepts);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			bodyEl.empty();
			bodyEl.createDiv({cls: "import-url-empty", text: `读取知识库失败：${message}`});
		}
	}

	private renderSummary(parentEl: HTMLElement, overview: WikiOverview): void {
		const summaryEl = parentEl.createDiv({cls: "import-url-wiki-summary"});
		createMetric(summaryEl, "待入库", overview.candidates.length);
		createMetric(summaryEl, "已入库", overview.concepts.length);
		createMetric(summaryEl, "图谱展示", overview.concepts.filter((concept) => concept.graphVisible).length);
	}

	private renderGraphGroupGuide(parentEl: HTMLElement): void {
		const guideEl = parentEl.createDiv({cls: "import-url-wiki-graph-guide"});
		const headerEl = guideEl.createDiv({cls: "import-url-wiki-graph-guide-header"});
		headerEl.createEl("h3", {text: "图谱颜色分组"});
		headerEl.createDiv({
			cls: "import-url-wiki-help",
			text: "在 Obsidian 图谱的分组里添加这些规则，就能区分已入库概念、待入库候选、AI 整理成文、原文和状态文件。",
		});

		const rulesEl = guideEl.createDiv({cls: "import-url-wiki-graph-rules"});
		for (const rule of GRAPH_GROUP_RULES) {
			this.renderGraphGroupRule(rulesEl, rule);
		}
	}

	private renderGraphGroupRule(parentEl: HTMLElement, rule: GraphGroupRule): void {
		const ruleEl = parentEl.createDiv({cls: `import-url-wiki-graph-rule is-${rule.tone}`});
		const mainEl = ruleEl.createDiv({cls: "import-url-wiki-graph-rule-main"});
		const titleEl = mainEl.createDiv({cls: "import-url-wiki-graph-rule-title"});
		titleEl.createEl("span", {cls: `import-url-wiki-color-dot is-${rule.tone}`});
		titleEl.createEl("span", {text: rule.label});
		mainEl.createDiv({cls: "import-url-wiki-graph-rule-description", text: rule.description});

		const queryEl = ruleEl.createDiv({cls: "import-url-wiki-graph-query"});
		queryEl.createEl("code", {text: rule.query});
		if (rule.copyable) {
			createButton(queryEl, "复制规则", async () => {
				const copied = await writeClipboardText(rule.query);
				new Notice(
					copied ? `已复制图谱分组规则：${rule.label}` : `复制失败，请手动使用：${rule.query}`,
					copied ? 2500 : 7000,
				);
			}, "is-muted");
		}
	}

	private renderPanelTabs(parentEl: HTMLElement, overview: WikiOverview): void {
		const tabsEl = parentEl.createDiv({cls: "import-url-wiki-tabs"});
		this.createPanelButton(tabsEl, "pending", `待入库 ${overview.candidates.length}`);
		this.createPanelButton(tabsEl, "approved", `已入库 ${overview.concepts.length}`);
	}

	private createPanelButton(parentEl: HTMLElement, panel: WikiManagerPanel, label: string): void {
		const buttonEl = createButton(parentEl, label, async () => {
			this.activePanel = panel;
			await this.render();
		}, "import-url-wiki-tab");
		if (this.activePanel === panel) {
			buttonEl.addClass("is-active");
		}
	}

	private renderSortBar(parentEl: HTMLElement): void {
		const toolbarEl = parentEl.createDiv({cls: "import-url-wiki-toolbar"});
		const sortGroupEl = toolbarEl.createDiv({cls: "import-url-wiki-toolbar-group"});
		sortGroupEl.createEl("span", {cls: "import-url-wiki-toolbar-label", text: "排序"});
		for (const option of SORT_OPTIONS) {
			const buttonEl = createButton(sortGroupEl, option.label, async () => {
				this.sortMode = option.mode;
				await this.render();
			});
			if (option.mode === this.sortMode) {
				buttonEl.addClass("is-active");
			}
		}

		const maintenanceEl = toolbarEl.createDiv({cls: "import-url-wiki-toolbar-group"});
		maintenanceEl.createEl("span", {cls: "import-url-wiki-toolbar-label", text: "维护"});
		createButton(maintenanceEl, "刷新", () => this.render());
		createButton(maintenanceEl, "重建真实关联", () => this.handleRebuildConceptGraph(), "is-primary");
		createButton(maintenanceEl, "清理旧图谱链接", () => this.handleCleanupLegacyLinks(), "is-muted");
	}

	private async handleCleanupLegacyLinks(): Promise<void> {
		try {
			const changedCount = await this.handlers.cleanupLegacyGraphLinks();
			new Notice(changedCount > 0 ? `已清理 ${changedCount} 篇旧 AI 整理笔记。` : "没有发现需要清理的旧图谱链接。", 4000);
			await this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`清理失败：${message}`, 6000);
		}
	}

	private async handleRebuildConceptGraph(): Promise<void> {
		try {
			const result = await this.handlers.rebuildConceptGraph();
			new Notice(`图谱已重建：清理 ${result.cleanedFiles} 篇笔记，补充分组 ${result.taggedFiles} 篇，更新 ${result.updatedConcepts} 个概念。`, 5000);
			await this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`重建失败：${message}`, 6000);
		}
	}

	private renderCandidateQueue(parentEl: HTMLElement, candidates: WikiCandidateOverview[]): void {
		const sectionEl = parentEl.createDiv({cls: "import-url-wiki-section"});
		sectionEl.createEl("h3", {text: "待入库概念"});

		if (candidates.length === 0) {
			sectionEl.createDiv({cls: "import-url-empty", text: "暂无待入库概念。"});
			return;
		}

		for (const candidate of candidates) {
			this.renderCandidateRecord(sectionEl, candidate);
		}
	}

	private renderCandidateRecord(parentEl: HTMLElement, candidate: WikiCandidateOverview): void {
		const recordEl = parentEl.createDiv({cls: "import-url-wiki-record is-pending"});
		const headerEl = recordEl.createDiv({cls: "import-url-wiki-record-header"});
		const titleWrapEl = headerEl.createDiv({cls: "import-url-wiki-title-wrap"});
		titleWrapEl.createDiv({cls: "import-url-wiki-title", text: candidate.title});
		titleWrapEl.createDiv({cls: "import-url-wiki-subtitle", text: candidate.targetConceptExists ? "批准后追加到已有概念页" : "批准后创建正式概念页"});
		const badgeEl = headerEl.createDiv({
			cls: candidate.targetConceptExists ? "import-url-wiki-badge is-update" : "import-url-wiki-badge is-pending",
			text: candidate.targetConceptExists ? "更新已有" : "新概念",
		});
		badgeEl.setAttr("title", candidate.targetConceptPath);

		const metaEl = recordEl.createDiv({cls: "import-url-wiki-meta-grid"});
		createMetaItem(metaEl, "导入", formatDate(candidate.generatedAt));
		createMetaItem(metaEl, "置信度", candidate.confidence || "未知");
		createMetaItem(metaEl, "链接次数", candidate.linkCount);
		recordEl.createDiv({
			cls: "import-url-wiki-path",
			text: candidate.sourceUrl || candidate.sourceNotePath || candidate.path,
		});

		const actionRowEl = recordEl.createDiv({cls: "import-url-wiki-action-row"});
		const decisionEl = actionRowEl.createDiv({cls: "import-url-wiki-decision"});
		const graphDefault = this.candidateGraphDrafts.get(candidate.path) ?? true;
		const graphInputEl = createSwitch(decisionEl, "入库后展示到图谱", graphDefault, (checked) => {
			this.candidateGraphDrafts.set(candidate.path, checked);
		});

		const actionsEl = actionRowEl.createDiv({cls: "import-url-wiki-actions"});
		createButton(actionsEl, "入库", () => this.handleAction(async () => {
			await this.handlers.approveCandidate(candidate.path, graphInputEl.checked);
			this.candidateGraphDrafts.delete(candidate.path);
		}, "已入库"), "is-primary");
		createButton(actionsEl, "打开候选", async () => {
			await this.handlers.openPath(candidate.path);
		});
		createButton(actionsEl, "拒绝", () => this.handleAction(async () => {
			await this.handlers.rejectCandidate(candidate.path);
			this.candidateGraphDrafts.delete(candidate.path);
		}, "已拒绝"), "is-danger");
	}

	private renderConceptLibrary(parentEl: HTMLElement, concepts: WikiConceptOverview[]): void {
		const sectionEl = parentEl.createDiv({cls: "import-url-wiki-section"});
		sectionEl.createEl("h3", {text: "已入库概念"});

		if (concepts.length === 0) {
			sectionEl.createDiv({cls: "import-url-empty", text: "暂无已入库概念。"});
			return;
		}

		for (const concept of concepts) {
			this.renderConceptRecord(sectionEl, concept);
		}
	}

	private renderConceptRecord(parentEl: HTMLElement, concept: WikiConceptOverview): void {
		const recordEl = parentEl.createDiv({cls: "import-url-wiki-record is-approved"});
		const headerEl = recordEl.createDiv({cls: "import-url-wiki-record-header"});
		const titleWrapEl = headerEl.createDiv({cls: "import-url-wiki-title-wrap"});
		titleWrapEl.createDiv({cls: "import-url-wiki-title", text: concept.title});
		titleWrapEl.createDiv({cls: "import-url-wiki-subtitle", text: concept.path});
		headerEl.createDiv({
			cls: concept.graphVisible ? "import-url-wiki-badge is-visible" : "import-url-wiki-badge is-hidden",
			text: concept.graphVisible ? "图谱展示" : "图谱隐藏",
		});

		const metaEl = recordEl.createDiv({cls: "import-url-wiki-meta-grid"});
		createMetaItem(metaEl, "导入", formatDate(concept.createdAt));
		createMetaItem(metaEl, "更新", formatDate(concept.updatedAt));
		createMetaItem(metaEl, "链接次数", concept.linkCount);

		const actionRowEl = recordEl.createDiv({cls: "import-url-wiki-action-row"});
		const decisionEl = actionRowEl.createDiv({cls: "import-url-wiki-decision"});
		createSwitch(decisionEl, "展示到图谱", concept.graphVisible, (checked) => {
			void this.handleAction(async () => {
				await this.handlers.setConceptGraphVisibility(concept.path, checked);
			});
		});

		const actionsEl = actionRowEl.createDiv({cls: "import-url-wiki-actions"});
		createButton(actionsEl, "打开概念", async () => {
			await this.handlers.openPath(concept.path);
		}, "is-primary");
	}

	private async handleAction(action: () => Promise<void>, successMessage?: string): Promise<void> {
		try {
			await action();
			if (successMessage) {
				new Notice(successMessage, 2500);
			}
			await this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`操作失败：${message}`, 6000);
		}
	}
}
