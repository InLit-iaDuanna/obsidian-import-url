import {App, ButtonComponent, Modal, Notice, TextComponent} from "obsidian";
import {findLatestImportForUrl, groupRecentImports} from "./history";
import {ImportHistoryEntry, ModelOption} from "./types";

interface ImportUrlModalOptions {
	isBusy: () => boolean;
	modelOptions: ModelOption[];
	initialModel: string;
	recentImports: ImportHistoryEntry[];
	resolveApiBaseUrl: (model: string) => string;
	openVaultPath: (path: string) => Promise<boolean>;
	onModelChange: (model: string) => Promise<void>;
	onClearRecentImports: () => Promise<boolean>;
	onSubmit: (rawUrl: string, model: string) => Promise<void>;
}

export class ImportUrlModal extends Modal {
	private readonly options: ImportUrlModalOptions;
	private input!: TextComponent;
	private submitButton!: ButtonComponent;
	private selectedModel: string;
	private recentImports: ImportHistoryEntry[];
	private modelListEl!: HTMLElement;
	private historyEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private summaryActionsEl!: HTMLElement;

	constructor(app: App, options: ImportUrlModalOptions) {
		super(app);
		this.options = options;
		this.selectedModel = options.initialModel;
		this.recentImports = options.recentImports;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass("import-url-modal");

		const heroEl = contentEl.createDiv({cls: "import-url-hero"});
		heroEl.createEl("h2", {text: "从 URL 导入"});
		heroEl.createEl("p", {
			text: "粘贴公开网页或直连 PDF URL，选择模型后生成原文笔记、AI 整理笔记和知识库概念候选页。",
			cls: "import-url-copy",
		});

		const inputWrapper = contentEl.createDiv({cls: "import-url-input-wrapper"});
		this.input = new TextComponent(inputWrapper);
		this.input.setPlaceholder("https://example.com/article");
		this.input.inputEl.addClass("import-url-input");
		this.input.onChange((value) => {
			this.updateSummary(value);
		});
		this.input.inputEl.focus();
		this.input.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.handleSubmit();
			}
		});

		const toolbarEl = contentEl.createDiv({cls: "import-url-toolbar"});
		new ButtonComponent(toolbarEl)
			.setButtonText("粘贴")
			.onClick(() => {
				void this.pasteClipboard();
			});
		new ButtonComponent(toolbarEl)
			.setButtonText("清空")
			.onClick(() => {
				this.input.setValue("");
				this.updateSummary("");
			});

		this.summaryEl = contentEl.createDiv({cls: "import-url-summary"});
		this.summaryActionsEl = contentEl.createDiv({cls: "import-url-summary-actions"});

		const modelSectionEl = contentEl.createDiv({cls: "import-url-section"});
		modelSectionEl.createEl("h3", {text: "模型"});
		modelSectionEl.createEl("p", {
			text: "为这次导入选择模型。模型 ID 也可以保存在设置页或 config.toml 中。",
			cls: "import-url-section-copy",
		});
		this.modelListEl = modelSectionEl.createDiv({cls: "import-url-model-list"});

		const historySectionEl = contentEl.createDiv({cls: "import-url-section"});
		const historyHeaderEl = historySectionEl.createDiv({cls: "import-url-section-header"});
		historyHeaderEl.createEl("h3", {text: "最近导入"});
		const clearHistoryButtonEl = historyHeaderEl.createEl("button", {
			text: "清空列表",
			cls: "import-url-link-button",
		});
		clearHistoryButtonEl.type = "button";
		clearHistoryButtonEl.addEventListener("click", () => {
			void this.clearRecentImports();
		});
		historySectionEl.createEl("p", {
			text: "按时间排序。可以回填 URL，也可以用同一模型重新导入。",
			cls: "import-url-section-copy",
		});
		this.historyEl = historySectionEl.createDiv({cls: "import-url-history"});

		const actionsEl = contentEl.createDiv({cls: "import-url-actions"});
		this.submitButton = new ButtonComponent(actionsEl)
			.setButtonText("导入")
			.setCta();
		this.submitButton.onClick(() => {
			this.handleSubmit();
		});

		new ButtonComponent(actionsEl)
			.setButtonText("取消")
			.onClick(() => this.close());

		this.renderModelOptions();
		this.renderHistory();
		this.updateSummary(this.input.getValue());
		this.refreshState();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private refreshState(): void {
		const busy = this.options.isBusy();
		this.input.setDisabled(busy);
		this.submitButton.setDisabled(busy);
	}

	private renderModelOptions(): void {
		this.modelListEl.empty();
		for (const option of this.options.modelOptions) {
			const buttonEl = this.modelListEl.createEl("button", {
				cls: "import-url-model-pill",
				text: option.label,
			});
			buttonEl.type = "button";
			if (option.id === this.selectedModel) {
				buttonEl.addClass("is-active");
			}
			buttonEl.setAttr("aria-pressed", option.id === this.selectedModel);
			buttonEl.title = option.description;
			buttonEl.addEventListener("click", () => {
				this.selectModel(option.id);
			});
		}
	}

	private renderHistory(): void {
		this.historyEl.empty();
		const groups = groupRecentImports(this.recentImports);
		if (groups.length === 0) {
			this.historyEl.createDiv({
				cls: "import-url-empty",
				text: "还没有导入历史。提交过的 URL 会显示在这里。",
			});
			return;
		}

		for (const group of groups) {
			const groupEl = this.historyEl.createDiv({cls: "import-url-history-group"});
			groupEl.createEl("h4", {
				text: group.label,
				cls: "import-url-history-heading",
			});

			for (const entry of group.entries) {
				const itemEl = groupEl.createDiv({cls: "import-url-history-item"});
				const headerEl = itemEl.createDiv({cls: "import-url-history-header"});
				headerEl.createEl("div", {
					text: entry.title || entry.host,
					cls: "import-url-history-title",
				});
				headerEl.createEl("div", {
					text: this.getStatusLabel(entry),
					cls: `import-url-history-status is-${entry.status}`,
				});

				itemEl.createDiv({
					text: entry.url,
					cls: "import-url-history-url",
				});

				itemEl.createDiv({
					text: `${this.formatTimestamp(entry.submittedAt)} · ${entry.model}`,
					cls: "import-url-history-meta",
				});

				const progressRowEl = itemEl.createDiv({cls: "import-url-history-progress"});
				const progressBarEl = progressRowEl.createDiv({cls: "import-url-history-progress-bar"});
				progressBarEl.createDiv({
					cls: "import-url-history-progress-fill",
					attr: {
						style: `width: ${entry.progressPercent}%;`,
					},
				});
				progressRowEl.createDiv({
					text: `${entry.progressPercent}% · ${entry.progressMessage}`,
					cls: "import-url-history-progress-text",
				});

				if (entry.errorMessage) {
					itemEl.createDiv({
						text: entry.errorMessage,
						cls: "import-url-history-error",
					});
				}

				const actionRowEl = itemEl.createDiv({cls: "import-url-history-actions"});
				const fillButton = actionRowEl.createEl("button", {
					text: "填入 URL",
					cls: "mod-cta",
				});
				fillButton.type = "button";
				fillButton.addEventListener("click", () => {
					this.input.setValue(entry.url);
					this.selectModel(entry.model, {showUnavailableNotice: true});
					this.updateSummary(entry.url);
				});

				const rerunButton = actionRowEl.createEl("button", {
					text: "重新导入",
				});
				rerunButton.type = "button";
				rerunButton.addEventListener("click", () => {
					this.input.setValue(entry.url);
					this.selectModel(entry.model, {showUnavailableNotice: true});
					this.updateSummary(entry.url);
					this.handleSubmit();
				});

				if (entry.notePath) {
					const notePath = entry.notePath;
					const openNoteButton = actionRowEl.createEl("button", {
						text: "打开 AI 整理",
					});
					openNoteButton.type = "button";
					openNoteButton.addEventListener("click", () => {
						void this.openPath(notePath);
					});
				}

				if (entry.originalNotePath) {
					const originalNotePath = entry.originalNotePath;
					const openOriginalButton = actionRowEl.createEl("button", {
						text: "打开原文",
					});
					openOriginalButton.type = "button";
					openOriginalButton.addEventListener("click", () => {
						void this.openPath(originalNotePath);
					});
				}

				if (entry.historyNotePath) {
					const historyNotePath = entry.historyNotePath;
					const openRecordButton = actionRowEl.createEl("button", {
						text: "打开记录",
					});
					openRecordButton.type = "button";
					openRecordButton.addEventListener("click", () => {
						void this.openPath(historyNotePath);
					});
				}
			}
		}
	}

	private getStatusLabel(entry: ImportHistoryEntry): string {
		if (entry.status === "complete") {
			return "已完成";
		}
		if (entry.status === "failed") {
			return "失败";
		}
		return "处理中";
	}

	private formatTimestamp(timestamp: string): string {
		return new Intl.DateTimeFormat(undefined, {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(timestamp));
	}

	private updateSummary(rawUrl: string): void {
		this.summaryEl.empty();
		this.summaryActionsEl.empty();
		const trimmed = rawUrl.trim();
		const modelText = this.options.modelOptions.find((option) => option.id === this.selectedModel)?.label ?? (this.selectedModel || "未选择模型");
		const apiBaseUrl = this.options.resolveApiBaseUrl(this.selectedModel);
		const apiText = apiBaseUrl || "未配置 API URL";
		const gridEl = this.summaryEl.createDiv({cls: "import-url-summary-grid"});

		if (!trimmed) {
			this.createSummaryField(gridEl, "来源", "等待粘贴 URL");
			this.createSummaryField(gridEl, "类型", "网页 / PDF");
			this.createSummaryField(gridEl, "模型", modelText);
			this.createSummaryField(gridEl, "API", apiText);
			return;
		}

		try {
			const url = new URL(trimmed);
			const looksLikePdf = url.pathname.toLowerCase().endsWith(".pdf");
			const latestMatch = findLatestImportForUrl(this.recentImports, trimmed);
			this.createSummaryField(gridEl, "来源", url.host);
			this.createSummaryField(gridEl, "类型", looksLikePdf ? "PDF" : "网页");
			this.createSummaryField(gridEl, "模型", modelText);
			this.createSummaryField(gridEl, "API", apiText);
			if (latestMatch) {
				this.createSummaryField(
					gridEl,
					"最近",
					`${this.getStatusLabel(latestMatch)} · ${this.formatTimestamp(latestMatch.submittedAt)} · ${latestMatch.model}`,
					"is-wide",
				);
				this.renderSummaryActions(latestMatch);
			}
		} catch {
			this.createSummaryField(gridEl, "来源", "URL 格式未完成");
			this.createSummaryField(gridEl, "类型", "等待识别");
			this.createSummaryField(gridEl, "模型", modelText);
			this.createSummaryField(gridEl, "API", apiText);
		}
	}

	private createSummaryField(parentEl: HTMLElement, label: string, value: string, className = ""): void {
		const fieldEl = parentEl.createDiv({cls: `import-url-summary-field ${className}`.trim()});
		fieldEl.createEl("span", {cls: "import-url-summary-label", text: label});
		fieldEl.createEl("strong", {text: value});
	}

	private renderSummaryActions(entry: ImportHistoryEntry): void {
		if (entry.notePath) {
			const notePath = entry.notePath;
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: "打开最近 AI 整理",
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				void this.openPath(notePath);
			});
		}

		if (entry.originalNotePath) {
			const originalNotePath = entry.originalNotePath;
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: "打开最近原文",
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				void this.openPath(originalNotePath);
			});
		}

		if (entry.historyNotePath) {
			const historyNotePath = entry.historyNotePath;
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: "打开最近记录",
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				void this.openPath(historyNotePath);
			});
		}

		if (entry.model !== this.selectedModel && this.hasSelectableModel(entry.model)) {
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: `切换到 ${entry.model}`,
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				this.selectModel(entry.model);
			});
		}
	}

	private hasSelectableModel(model: string): boolean {
		return this.options.modelOptions.some((option) => option.id === model);
	}

	private selectModel(model: string, options: {showUnavailableNotice?: boolean} = {}): void {
		if (!this.hasSelectableModel(model)) {
			if (options.showUnavailableNotice) {
				new Notice("这条历史记录使用的旧模型不在当前模型列表中，已保留当前选择。", 4000);
			}
			return;
		}

		this.selectedModel = model;
		this.renderModelOptions();
		this.updateSummary(this.input.getValue());
		void this.options.onModelChange(model);
	}

	private async openPath(path: string): Promise<void> {
		const opened = await this.options.openVaultPath(path);
		if (opened) {
			this.close();
		}
	}

	private async pasteClipboard(): Promise<void> {
		try {
			const clipboardText = await navigator.clipboard?.readText?.();
			if (!clipboardText?.trim()) {
				new Notice("剪贴板中没有 URL。", 3000);
				return;
			}

			this.input.setValue(clipboardText.trim());
			this.updateSummary(clipboardText.trim());
		} catch {
			new Notice("无法读取剪贴板，请手动粘贴。", 4000);
		}
	}

	private async clearRecentImports(): Promise<void> {
		if (this.options.isBusy()) {
			new Notice("有导入任务正在运行，完成后再清空最近导入。", 4000);
			return;
		}

		if (this.recentImports.length === 0) {
			new Notice("最近导入列表已经是空的。", 2500);
			return;
		}

		const cleared = await this.options.onClearRecentImports();
		if (!cleared) {
			return;
		}

		this.recentImports = [];
		this.renderHistory();
		this.updateSummary(this.input.getValue());
	}

	private handleSubmit(): void {
		if (this.options.isBusy()) {
			new Notice("已有导入任务正在运行，请稍后。", 4000);
			return;
		}

		const rawUrl = this.input.getValue().trim();
		if (!rawUrl) {
			new Notice("请先输入 URL。", 3000);
			return;
		}
		if (!this.selectedModel.trim()) {
			new Notice("请先选择模型 ID。", 3000);
			return;
		}

		void this.options.onSubmit(rawUrl, this.selectedModel);
		this.close();
	}
}
