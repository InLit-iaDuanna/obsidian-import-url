import type ImportUrlPlugin from "./main";

interface ImportUrlCommandHandlers {
	openImportModal: () => Promise<void>;
	openConfigToml: () => Promise<void>;
	importClipboardUrl: () => Promise<void>;
}

export function registerImportUrlCommands(
	plugin: ImportUrlPlugin,
	handlers: ImportUrlCommandHandlers,
): void {
	plugin.addRibbonIcon("link", "Import URL", () => {
		void handlers.openImportModal();
	});

	plugin.addCommand({
		id: "import",
		name: "Import from URL",
		callback: () => {
			void handlers.openImportModal();
		},
	});

	plugin.addCommand({
		id: "import-from-clipboard",
		name: "Import from clipboard",
		callback: () => {
			void handlers.importClipboardUrl();
		},
	});

	plugin.addCommand({
		id: "open-config",
		name: "Open config file",
		callback: () => {
			void handlers.openConfigToml();
		},
	});
}
