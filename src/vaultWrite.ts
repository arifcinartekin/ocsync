import { App, TFile } from "obsidian";

async function ensureParentFolder(app: App, path: string): Promise<void> {
	const idx = path.lastIndexOf("/");
	if (idx === -1) return;
	const folderPath = path.slice(0, idx);
	if (folderPath.length === 0) return;
	if (app.vault.getAbstractFileByPath(folderPath)) return;
	try {
		await app.vault.createFolder(folderPath);
	} catch {
		// Folder was likely created concurrently (or by an intermediate step) - safe to ignore.
	}
}

/** Creates the file (and any missing parent folders) or overwrites it if it already exists. */
export async function writeLocalFile(app: App, path: string, data: ArrayBuffer): Promise<void> {
	await ensureParentFolder(app, path);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, data);
	} else {
		await app.vault.createBinary(path, data);
	}
}
