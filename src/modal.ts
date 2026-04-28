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
	private summaryActionsEl!: HTMLElement;

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
		heroEl.createEl("h2", {text: "Import from URL"});
		heroEl.createEl("p", {
			text: "Paste a public webpage or direct PDF URL, choose a model, and continue from recent import history.",
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
			.setButtonText("Paste")
			.onClick(() => {
				void this.pasteClipboard();
			});
		new ButtonComponent(toolbarEl)
			.setButtonText("Clear")
			.onClick(() => {
				this.input.setValue("");
				this.updateSummary("");
			});

		this.summaryEl = contentEl.createDiv({cls: "import-url-summary"});
		this.summaryActionsEl = contentEl.createDiv({cls: "import-url-summary-actions"});

		const modelSectionEl = contentEl.createDiv({cls: "import-url-section"});
		modelSectionEl.createEl("h3", {text: "Model"});
		modelSectionEl.createEl("p", {
			text: "Pick a model for this import. Your last choice is remembered.",
			cls: "import-url-section-copy",
		});
		this.modelListEl = modelSectionEl.createDiv({cls: "import-url-model-list"});

		const historySectionEl = contentEl.createDiv({cls: "import-url-section"});
		historySectionEl.createEl("h3", {text: "Recent imports"});
		historySectionEl.createEl("p", {
			text: "Sorted by time. Fill the URL back into input or run the same import again.",
			cls: "import-url-section-copy",
		});
		this.historyEl = historySectionEl.createDiv({cls: "import-url-history"});

		const actionsEl = contentEl.createDiv({cls: "import-url-actions"});
		this.submitButton = new ButtonComponent(actionsEl)
			.setButtonText("Import")
			.setCta();
		this.submitButton.onClick(() => {
			this.handleSubmit();
		});

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
				text: "No import history yet. Submitted URLs will appear here.",
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
				if (entry.notePath) {
					const notePath = entry.notePath;
					const openNoteButton = actionRowEl.createEl("button", {
						text: "Open note",
					});
					openNoteButton.type = "button";
					openNoteButton.addEventListener("click", () => {
						void this.openPath(notePath);
					});
				}

				if (entry.historyNotePath) {
					const historyNotePath = entry.historyNotePath;
					const openRecordButton = actionRowEl.createEl("button", {
						text: "Open record",
					});
					openRecordButton.type = "button";
					openRecordButton.addEventListener("click", () => {
						void this.openPath(historyNotePath);
					});
				}

				const fillButton = actionRowEl.createEl("button", {
					text: "Fill URL",
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
					text: "Re-import",
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
			return "Complete";
		}
		if (entry.status === "failed") {
			return "Failed";
		}
		return "Processing";
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
		const modelText = this.options.modelOptions.find((option) => option.id === this.selectedModel)?.label ?? this.selectedModel;
		const apiBaseUrl = this.options.resolveApiBaseUrl(this.selectedModel);
		const apiText = apiBaseUrl || "No API URL configured";

		if (!trimmed) {
			this.summaryEl.setText(`Model: ${modelText} · API URL: ${apiText}. Supports public webpages and direct PDF URLs.`);
			return;
		}

		try {
			const url = new URL(trimmed);
			const looksLikePdf = url.pathname.toLowerCase().endsWith(".pdf");
			const latestMatch = findLatestImportForUrl(this.options.recentImports, trimmed);
			const latestSummary = latestMatch
				? ` · Latest: ${this.getStatusLabel(latestMatch)} · ${this.formatTimestamp(latestMatch.submittedAt)} · ${latestMatch.model}`
				: "";
			this.summaryEl.setText(`Source: ${url.host} · Type: ${looksLikePdf ? "PDF" : "Webpage"} · Model: ${modelText} · API URL: ${apiText}${latestSummary}`);
			if (latestMatch) {
				this.renderSummaryActions(latestMatch);
			}
		} catch {
			this.summaryEl.setText(`URL format is incomplete. You can keep pasting. Model: ${modelText} · API URL: ${apiText}`);
		}
	}

	private renderSummaryActions(entry: ImportHistoryEntry): void {
		if (entry.notePath) {
			const notePath = entry.notePath;
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: "Open latest note",
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				void this.openPath(notePath);
			});
		}

		if (entry.historyNotePath) {
			const historyNotePath = entry.historyNotePath;
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: "Open latest record",
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				void this.openPath(historyNotePath);
			});
		}

		if (entry.model !== this.selectedModel) {
			const buttonEl = this.summaryActionsEl.createEl("button", {
				text: `Switch to ${entry.model}`,
			});
			buttonEl.type = "button";
			buttonEl.addEventListener("click", () => {
				this.selectedModel = entry.model;
				this.renderModelOptions();
				this.updateSummary(this.input.getValue());
			});
		}
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
				new Notice("No URL found in clipboard.", 3000);
				return;
			}

			this.input.setValue(clipboardText.trim());
			this.updateSummary(clipboardText.trim());
		} catch {
			new Notice("Could not read clipboard. Paste manually.", 4000);
		}
	}

	private handleSubmit(): void {
		if (this.options.isBusy()) {
			new Notice("Another import is already running. Please wait.", 4000);
			return;
		}

		const rawUrl = this.input.getValue().trim();
		if (!rawUrl) {
			new Notice("Enter a URL first.", 3000);
			return;
		}

		void this.options.onSubmit(rawUrl, this.selectedModel);
		this.close();
	}
}
