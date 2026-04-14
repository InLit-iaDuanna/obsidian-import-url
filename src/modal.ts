import {App, ButtonComponent, Modal, Notice, TextComponent} from "obsidian";
import {groupRecentImports} from "./history";
import {ImportHistoryEntry, ModelOption} from "./types";

interface ImportUrlModalOptions {
	isBusy: () => boolean;
	modelOptions: ModelOption[];
	initialModel: string;
	recentImports: ImportHistoryEntry[];
	resolveApiBaseUrl: (model: string) => string;
	onSubmit: (rawUrl: string, model: string) => Promise<void>;
}

export class ImportUrlModal extends Modal {
	private readonly options: ImportUrlModalOptions;
	private input!: TextComponent;
	private submitButton!: ButtonComponent;
	private selectedModel: string;
	private modelListEl!: HTMLElement;
	private historyEl!: HTMLElement;
	private summaryEl!: HTMLElement;

	constructor(app: App, options: ImportUrlModalOptions) {
		super(app);
		this.options = options;
		this.selectedModel = options.initialModel;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass("import-url-modal");

		const heroEl = contentEl.createDiv({cls: "import-url-hero"});
		heroEl.createEl("h2", {text: "Import URL"});
		heroEl.createEl("p", {
			text: "粘贴一个公开网页或公开直达 PDF URL，快速选择模型，并从最近记录里继续上次的导入。",
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
			.setButtonText("粘贴剪贴板")
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

		const modelSectionEl = contentEl.createDiv({cls: "import-url-section"});
		modelSectionEl.createEl("h3", {text: "模型"});
		modelSectionEl.createEl("p", {
			text: "点一下就能切换本次导入模型；会记住你最后一次使用的选择。",
			cls: "import-url-section-copy",
		});
		this.modelListEl = modelSectionEl.createDiv({cls: "import-url-model-list"});

		const historySectionEl = contentEl.createDiv({cls: "import-url-section"});
		historySectionEl.createEl("h3", {text: "最近提交"});
		historySectionEl.createEl("p", {
			text: "按时间整理。可以填回输入框继续改，也可以直接再导入一次。",
			cls: "import-url-section-copy",
		});
		this.historyEl = historySectionEl.createDiv({cls: "import-url-history"});

		const actionsEl = contentEl.createDiv({cls: "import-url-actions"});
		this.submitButton = new ButtonComponent(actionsEl)
			.setButtonText("Import URL")
			.setCta();
		this.submitButton.onClick(() => this.handleSubmit());

		new ButtonComponent(actionsEl)
			.setButtonText("Cancel")
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
		if (this.input) {
			this.input.setDisabled(busy);
		}
		if (this.submitButton) {
			this.submitButton.setDisabled(busy);
		}
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
				this.selectedModel = option.id;
				this.renderModelOptions();
				this.updateSummary(this.input.getValue());
			});
		}
	}

	private renderHistory(): void {
		this.historyEl.empty();
		const groups = groupRecentImports(this.options.recentImports);
		if (groups.length === 0) {
			this.historyEl.createDiv({
				cls: "import-url-empty",
				text: "还没有导入历史。你提交过的 URL 会自动记录在这里。",
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
					text: "填入",
					cls: "mod-cta",
				});
				fillButton.type = "button";
				fillButton.addEventListener("click", () => {
					this.input.setValue(entry.url);
					this.selectedModel = entry.model;
					this.renderModelOptions();
					this.updateSummary(entry.url);
				});

				const rerunButton = actionRowEl.createEl("button", {
					text: "再导入",
				});
				rerunButton.type = "button";
				rerunButton.addEventListener("click", () => {
					this.input.setValue(entry.url);
					this.selectedModel = entry.model;
					this.renderModelOptions();
					this.updateSummary(entry.url);
					this.handleSubmit();
				});
			}
		}
	}

	private getStatusLabel(entry: ImportHistoryEntry): string {
		if (entry.status === "complete") {
			return "成功";
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
		const trimmed = rawUrl.trim();
		const modelText = this.options.modelOptions.find((option) => option.id === this.selectedModel)?.label ?? this.selectedModel;
		const apiBaseUrl = this.options.resolveApiBaseUrl(this.selectedModel);
		const apiText = apiBaseUrl || "未设置 API 地址";

		if (!trimmed) {
			this.summaryEl.setText(`当前模型：${modelText} · 接口：${apiText}。支持公开网页和公开直达 PDF。`);
			return;
		}

		try {
			const url = new URL(trimmed);
			const looksLikePdf = url.pathname.toLowerCase().endsWith(".pdf");
			this.summaryEl.setText(`来源：${url.host} · 类型预判：${looksLikePdf ? "PDF" : "网页"} · 当前模型：${modelText} · 接口：${apiText}`);
		} catch {
			this.summaryEl.setText(`URL 格式还不完整，但你可以继续粘贴。当前模型：${modelText} · 接口：${apiText}`);
		}
	}

	private async pasteClipboard(): Promise<void> {
		try {
			const clipboardText = await navigator.clipboard?.readText?.();
			if (!clipboardText?.trim()) {
				new Notice("剪贴板里没有可用的 URL。", 3000);
				return;
			}

			this.input.setValue(clipboardText.trim());
			this.updateSummary(clipboardText.trim());
		} catch {
			new Notice("读取剪贴板失败，请手动粘贴。", 4000);
		}
	}

	private handleSubmit(): void {
		if (this.options.isBusy()) {
			new Notice("已有导入任务正在进行，请稍候。", 4000);
			return;
		}

		const rawUrl = this.input.getValue().trim();
		if (!rawUrl) {
			new Notice("请先输入 URL。", 3000);
			return;
		}

		void this.options.onSubmit(rawUrl, this.selectedModel);
		this.close();
	}
}
