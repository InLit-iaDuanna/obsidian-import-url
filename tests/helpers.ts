import {App, RequestUrlResponse} from "obsidian";

export interface FakeFile {
	path: string;
	content: string;
}

interface FakeFolder {
	path: string;
}

type Entry = FakeFile | FakeFolder;

function isFakeFile(entry: Entry): entry is FakeFile {
	return "content" in entry;
}

export class FakeVault {
	private readonly entries = new Map<string, Entry>();

	getAbstractFileByPath(path: string): Entry | null {
		return this.entries.get(path) ?? null;
	}

	async createFolder(path: string): Promise<void> {
		if (!this.entries.has(path)) {
			this.entries.set(path, {path});
		}
	}

	async create(path: string, content: string): Promise<FakeFile> {
		if (this.entries.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}

		const file: FakeFile = {path, content};
		this.entries.set(path, file);
		return file;
	}

	async modify(file: FakeFile, content: string): Promise<void> {
		file.content = content;
		this.entries.set(file.path, file);
	}

	async cachedRead(file: FakeFile): Promise<string> {
		return file.content;
	}

	async rename(file: FakeFile, targetPath: string): Promise<void> {
		const existing = this.entries.get(targetPath);
		if (existing && existing !== file) {
			throw new Error(`Target already exists: ${targetPath}`);
		}

		this.entries.delete(file.path);
		file.path = targetPath;
		this.entries.set(targetPath, file);
	}

	listFiles(): FakeFile[] {
		return [...this.entries.values()].filter(isFakeFile);
	}

	read(path: string): string {
		const entry = this.entries.get(path);
		if (!entry || !isFakeFile(entry)) {
			throw new Error(`No file at path: ${path}`);
		}

		return entry.content;
	}
}

export class FakeWorkspace {
	readonly openedFiles: FakeFile[] = [];

	getLeaf(): {openFile: (file: FakeFile) => Promise<void>} {
		return {
			openFile: async (file: FakeFile) => {
				this.openedFiles.push(file);
			},
		};
	}
}

export function createFakeApp(): {app: App; vault: FakeVault; workspace: FakeWorkspace} {
	const vault = new FakeVault();
	const workspace = new FakeWorkspace();
	return {
		app: {vault, workspace} as unknown as App,
		vault,
		workspace,
	};
}

export function createResponse(status: number, text: string, headers: Record<string, string> = {}): RequestUrlResponse {
	let parsedJson: unknown = null;
	try {
		parsedJson = JSON.parse(text);
	} catch {
		parsedJson = null;
	}

	return {
		status,
		text,
		headers,
		arrayBuffer: new ArrayBuffer(0),
		json: parsedJson,
	} as RequestUrlResponse;
}
