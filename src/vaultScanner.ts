import { App, TFile } from "obsidian";
import { sha256Hex } from "./crypto";
import { isExcluded } from "./pathMatch";
import { ScannedFile } from "./types";

/**
 * Reads and hashes every non-excluded file in the vault. Note this reads
 * full file contents into memory to compute the SHA-256 content hash used
 * for content-addressed storage - fine for typical note/attachment sizes,
 * but large vaults with many big binary attachments will be memory-heavier.
 */
export async function scanVault(app: App, excludePatterns: string[]): Promise<ScannedFile[]> {
	const files = app.vault.getFiles().filter((f: TFile) => !isExcluded(f.path, excludePatterns));

	const scanned: ScannedFile[] = [];
	for (const file of files) {
		const data = await app.vault.readBinary(file);
		const hash = await sha256Hex(data);
		scanned.push({
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
			hash,
			data,
		});
	}
	return scanned;
}
