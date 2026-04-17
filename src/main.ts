import {Notice, Plugin} from "obsidian";
import {applyConfigTomlOverrides, readImportUrlConfigToml, renderDefaultConfigToml} from "./config-toml";
import {normalizeRecentImports, updateRecentImport, upsertRecentImport} from "./history";
import {getModelOptions, getPrimaryModel, normalizeCustomModels, normalizeModelApiBaseUrls, resolveModelApiBaseUrl} from "./model-catalog";
import {ImportUrlModal} from "./modal";
import {JobRunner} from "./pipeline/job-runner";
import {parseHttpUrl} from "./pipeline/url-validator";
import {buildHistoryFileName, renderHistoryNote} from "./render/history-note";
import {randomHexSuffix} from "./render/notes";
import {DEFAULT_SETTINGS, ImportUrlSettingTab, readSecretValue} from "./settings";
import {ImportHistoryEntry, ImportUrlPluginSettings, JobProgressEvent, JobRunResult, UserInputError} from "./types";
import {TFile} from "obsidian";

export default class ImportUrlPlugin extends Plugin {
	settings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private effectiveSettings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private jobRunner!: JobRunner;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.tryEnsureConfigTomlReady();
		await this.refreshEffectiveSettings();

		this.jobRunner = new JobRunner({
			app: this.app,
			getSettings: () => this.effectiveSettings,
			getApiKey: async (secretName: string) => readSecretValue(this.app, secretName),
			deps: {
				onProgress: (event) => this.handleJobProgress(event),
			},
		});

		this.addRibbonIcon("link", "Import URL", () => {
			void this.openImportModal();
		});

		this.addCommand({
			id: "import",
			name: "Import from URL",
			callback: () => {
				void this.openImportModal();
			},
		});

		this.addCommand({
			id: "open-config",
			name: "Open config file",
			callback: () => {
				void this.openConfigToml();
			},
		});

		this.addSettingTab(new ImportUrlSettingTab(this.app, this));
	}

	private async tryEnsureConfigTomlReady(): Promise<void> {
		try {
			await this.ensureConfigTomlReady();
		} catch (error) {
			console.error("[import-url] failed to initialize config.toml", error);
			new Notice("Failed to initialize config.toml. The plugin will continue loading.", 7000);
		}
	}

	async getEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		return this.refreshEffectiveSettings();
	}

	async ensureConfigTomlReady(): Promise<void> {
		const configPath = this.settings.configTomlPath.trim() || DEFAULT_SETTINGS.configTomlPath;
		const folder = configPath.split("/").slice(0, -1).join("/");
		if (folder) {
			await this.ensureFolder(folder);
		}

		if (this.app.vault.getAbstractFileByPath(configPath)) {
			return;
		}

		await this.app.vault.create(configPath, renderDefaultConfigToml(this.settings));
	}

	async openConfigToml(): Promise<void> {
		await this.ensureConfigTomlReady();
		const configPath = this.settings.configTomlPath.trim() || DEFAULT_SETTINGS.configTomlPath;
		const file = this.app.vault.getAbstractFileByPath(configPath) as TFile | null;
		if (!file) {
			new Notice("Failed to create config.toml. Check the configured path.", 5000);
			return;
		}

		await this.app.workspace.getLeaf(true).openFile(file);
	}

	private async refreshEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		try {
			const config = await readImportUrlConfigToml(this.app, this.settings.configTomlPath);
			this.effectiveSettings = applyConfigTomlOverrides(this.settings, config);
		} catch (error) {
			console.error("[import-url] failed to read config.toml", error);
			this.effectiveSettings = applyConfigTomlOverrides(this.settings, null);
			new Notice("Failed to parse config.toml. Using values from the settings tab.", 6000);
		}

		return this.effectiveSettings;
	}

	private async openImportModal(): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		new ImportUrlModal(this.app, {
			isBusy: () => this.jobRunner.isBusy(),
			modelOptions: getModelOptions(effectiveSettings),
			initialModel: effectiveSettings.model,
			recentImports: this.settings.recentImports,
			resolveApiBaseUrl: (model) => resolveModelApiBaseUrl(effectiveSettings, model),
			onSubmit: (rawUrl: string, model: string) => this.startImport(rawUrl, model),
		}).open();
	}

	private async startImport(rawUrl: string, selectedModel: string): Promise<void> {
		let historyEntry: ImportHistoryEntry | null = null;

		try {
			const effectiveSettings = await this.refreshEffectiveSettings();
			const normalizedUrl = parseHttpUrl(rawUrl).toString();
			const activeModel = getPrimaryModel(selectedModel, effectiveSettings.model);
			const resolvedApiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, activeModel) || effectiveSettings.apiBaseUrl;

			if (this.jobRunner.isBusy()) {
				throw new UserInputError("Another import is already running. Please wait.");
			}

			if (activeModel !== this.settings.model) {
				this.settings.model = activeModel;
			}

			historyEntry = await this.createHistoryEntry(normalizedUrl, activeModel, resolvedApiBaseUrl);
			await this.saveSettings();

			const result = await this.jobRunner.run({
				rawUrl: normalizedUrl,
				model: activeModel,
				apiBaseUrl: resolvedApiBaseUrl,
				historyId: historyEntry.id,
			});
			await this.applyJobResult(historyEntry.id, result);
		} catch (error) {
			if (error instanceof UserInputError) {
				if (historyEntry) {
					this.removeHistoryEntry(historyEntry.id);
					await this.saveSettings();
				}
				new Notice(error.message, 5000);
				return;
			}

			if (historyEntry) {
				let updatedEntry: ImportHistoryEntry | null = null;
				this.settings.recentImports = updateRecentImport(this.settings.recentImports, historyEntry.id, (entry) => ({
					...(updatedEntry = {
						...entry,
						status: "failed",
						errorMessage: error instanceof Error ? error.message : "Unknown error",
					}),
				}));
				await this.saveSettings();
				if (updatedEntry) {
					await this.writeVisibleHistoryNote(updatedEntry);
				}
			}
			console.error("[import-url] unexpected import failure", error);
			new Notice("Import failed. Processing or failed notes were kept when possible.", 6000);
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.readStoredSettingsSafely();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		this.settings.customModels = normalizeCustomModels(Array.isArray(this.settings.customModels) ? this.settings.customModels : []);
		this.settings.modelApiBaseUrls = normalizeModelApiBaseUrls(Array.isArray(this.settings.modelApiBaseUrls) ? this.settings.modelApiBaseUrls : []);
		this.settings.configTomlPath = this.settings.configTomlPath?.trim() || DEFAULT_SETTINGS.configTomlPath;
		this.settings.recentImports = normalizeRecentImports(this.settings.recentImports);
		this.effectiveSettings = this.settings;
	}

	private async readStoredSettingsSafely(): Promise<Partial<ImportUrlPluginSettings> | null> {
		try {
			return await this.loadData() as Partial<ImportUrlPluginSettings> | null;
		} catch (error) {
			console.error("[import-url] failed to read data.json, falling back to defaults", error);
			new Notice("Settings file is invalid. Restored defaults automatically.", 7000);

			this.settings = Object.assign({}, DEFAULT_SETTINGS);
			try {
				await this.saveData(this.settings);
			} catch (saveError) {
				console.error("[import-url] failed to rewrite default settings after data read error", saveError);
			}

			return null;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async createHistoryEntry(url: string, model: string, apiBaseUrl: string): Promise<ImportHistoryEntry> {
		const host = new URL(url).host || "source";
		const entry: ImportHistoryEntry = {
			id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			url,
			host,
			apiBaseUrl,
			model,
			submittedAt: new Date().toISOString(),
			status: "processing",
			progressStage: "queued",
			progressPercent: 0,
			progressMessage: "Queued",
			progressUpdatedAt: new Date().toISOString(),
		};

		entry.historyNotePath = await this.createVisibleHistoryNote(entry);
		this.settings.recentImports = upsertRecentImport(this.settings.recentImports, entry);
		return entry;
	}

	private async applyJobResult(historyId: string, result: JobRunResult): Promise<void> {
		let updatedEntry: ImportHistoryEntry | null = null;
		this.settings.recentImports = updateRecentImport(this.settings.recentImports, historyId, (entry) => ({
			...(updatedEntry = {
				...entry,
					status: result.status,
					model: result.model,
					title: result.title,
					notePath: result.notePath,
					sourceType: result.sourceType,
					errorMessage: result.failure?.errorMessage,
					progressStage: result.status === "complete" ? "complete" : "failed",
					progressPercent: 100,
					progressMessage: result.status === "complete" ? "Import complete" : (result.failure?.errorMessage ?? "Import failed"),
					progressUpdatedAt: new Date().toISOString(),
				}),
			}));
		await this.saveSettings();
		if (updatedEntry) {
			await this.writeVisibleHistoryNote(updatedEntry);
		}
	}

	private removeHistoryEntry(historyId: string): void {
		this.settings.recentImports = this.settings.recentImports.filter((entry) => entry.id !== historyId);
	}

	private async handleJobProgress(event: JobProgressEvent): Promise<void> {
		if (!event.historyId) {
			return;
		}

		let updatedEntry: ImportHistoryEntry | null = null;
		this.settings.recentImports = updateRecentImport(this.settings.recentImports, event.historyId, (entry) => ({
			...(updatedEntry = {
				...entry,
				model: event.model,
				progressStage: event.stage,
				progressPercent: event.progressPercent,
				progressMessage: event.message,
				progressUpdatedAt: new Date().toISOString(),
				sourceType: event.sourceType ?? entry.sourceType,
				title: event.title ?? entry.title,
			}),
		}));
		await this.saveSettings();
		if (updatedEntry) {
			await this.writeVisibleHistoryNote(updatedEntry);
		}
	}

	private async createVisibleHistoryNote(entry: ImportHistoryEntry): Promise<string | undefined> {
		try {
			await this.ensureFolder(this.settings.historyFolder);
			const suffix = randomHexSuffix();
			const path = await this.resolveUniquePath(
				this.settings.historyFolder,
				buildHistoryFileName(entry.host, suffix, new Date(entry.submittedAt)),
				suffix,
			);
			await this.app.vault.create(path, renderHistoryNote(entry));
			return path;
		} catch (error) {
			console.error("[import-url] failed to create visible history note", error);
			return undefined;
		}
	}

	private async writeVisibleHistoryNote(entry: ImportHistoryEntry): Promise<void> {
		if (!entry.historyNotePath) {
			return;
		}

		try {
			await this.ensureFolder(this.settings.historyFolder);
			const file = this.app.vault.getAbstractFileByPath(entry.historyNotePath) as TFile | null;
			if (!file) {
				await this.app.vault.create(entry.historyNotePath, renderHistoryNote(entry));
				return;
			}

			await this.app.vault.modify(file, renderHistoryNote(entry));
		} catch (error) {
			console.error("[import-url] failed to update visible history note", error);
		}
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private async resolveUniquePath(folder: string, fileName: string, suffix: string): Promise<string> {
		let candidate = `${folder.replace(/\/+$/u, "")}/${fileName}`;

		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		const extension = ".md";
		const stem = candidate.endsWith(extension) ? candidate.slice(0, -extension.length) : candidate;
		candidate = `${stem} - ${suffix}${extension}`;

		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(`${stem} - ${suffix}-${counter}${extension}`)) {
			counter += 1;
		}

		return `${stem} - ${suffix}-${counter}${extension}`;
	}
}
