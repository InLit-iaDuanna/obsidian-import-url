import {Notice, Plugin} from "obsidian";
import {registerImportUrlCommands} from "./commands";
import {ImportController} from "./import-controller";
import {DEFAULT_SETTINGS, ImportUrlSettingTab} from "./settings";
import {ImportUrlPluginSettings} from "./types";

export default class ImportUrlPlugin extends Plugin {
	settings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private controller?: ImportController;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.getController().initialize();

		registerImportUrlCommands(this, {
			openImportModal: () => this.getController().openImportModal(),
			openConfigToml: () => this.getController().openConfigToml(),
			importClipboardUrl: () => this.getController().importClipboardUrl(),
		});

		this.addSettingTab(new ImportUrlSettingTab(this.app, this));
	}

	async getEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		return this.getController().getEffectiveSettings();
	}

	async ensureConfigTomlReady(): Promise<void> {
		await this.getController().ensureConfigTomlReady();
	}

	async openConfigToml(): Promise<void> {
		await this.getController().openConfigToml();
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.readStoredSettingsSafely();
		this.getController().loadStoredSettings(loaded);
	}

	private getController(): ImportController {
		if (!this.controller) {
			this.controller = new ImportController(this);
		}
		return this.controller;
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
}
