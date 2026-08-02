import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, OCSyncSettings, OCSyncSettingTab } from "./settings";
import { PasswordModal } from "./passwordModal";
import { GitHubClient } from "./github";
import { base64ToBytes, bytesToBase64, deriveKey, encryptBytes, generateSalt } from "./crypto";
import { decryptManifest, encryptManifest } from "./manifest";
import { commitChanges, PendingBlob } from "./gitCommit";
import { scanVault } from "./vaultScanner";
import { DEFAULT_LOCAL_STATE, emptyManifest, LocalSyncState, Manifest } from "./types";
import { runSync } from "./syncEngine";

const SALT_PATH = "salt.txt";
const MANIFEST_PATH = "manifest.enc";

interface PersistedData {
	settings: OCSyncSettings;
	localState: LocalSyncState;
}

type SyncStatus = "locked" | "idle" | "syncing" | "ok" | "error";

/**
 * Encodes a UTF-8 string as the base64 payload the GitHub Contents API
 * expects for a plain-text file (e.g. salt.txt).
 */
function textToContentBase64(text: string): string {
	return bytesToBase64(new TextEncoder().encode(text));
}

function contentBase64ToText(contentBase64: string): string {
	return new TextDecoder().decode(base64ToBytes(contentBase64));
}

export default class OCSyncPlugin extends Plugin {
	settings: OCSyncSettings = DEFAULT_SETTINGS;
	private localState: LocalSyncState = DEFAULT_LOCAL_STATE;

	/**
	 * Session-only state. The derived key and salt live in memory for as
	 * long as Obsidian stays open and are never written to disk.
	 */
	private sessionKey: CryptoKey | null = null;

	private statusBarItem: HTMLElement | null = null;
	private status: SyncStatus = "locked";
	private isSyncing = false;
	private syncIntervalId: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new OCSyncSettingTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem();
		this.setStatus("locked");

		this.addCommand({
			id: "ocsync-unlock",
			name: "Unlock encryption password",
			callback: () => this.promptForPassword(),
		});

		this.addCommand({
			id: "ocsync-sync-active-file",
			name: "Debug: test push active file only",
			callback: () => this.manualSyncActiveFile(),
		});

		this.addCommand({
			id: "ocsync-sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});

		this.addCommand({
			id: "ocsync-push-vault",
			name: "Debug: push-only full vault sync (no pull)",
			callback: () => this.pushFullVault(),
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.hasCompleteGitHubSettings()) {
				this.promptForPassword();
			}
		});
	}

	onunload(): void {
		this.sessionKey = null;
		this.stopSyncLoop();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
		this.localState = Object.assign({}, DEFAULT_LOCAL_STATE, data.localState);
	}

	async saveSettings(): Promise<void> {
		await this.persistData();
	}

	private async saveLocalState(): Promise<void> {
		await this.persistData();
	}

	private async persistData(): Promise<void> {
		const data: PersistedData = { settings: this.settings, localState: this.localState };
		await this.saveData(data);
	}

	/**
	 * (Re)starts the background timer that calls syncNow() automatically.
	 * Only runs once the vault is unlocked; safe to call repeatedly (e.g. on
	 * every settings change) since it always clears any previous timer first.
	 */
	restartSyncLoop(): void {
		this.stopSyncLoop();
		if (!this.sessionKey || !this.hasCompleteGitHubSettings()) return;

		const intervalMs = Math.max(1, this.settings.syncIntervalSeconds) * 1000;
		this.syncIntervalId = window.setInterval(() => {
			void this.syncNow(true);
		}, intervalMs);
		this.registerInterval(this.syncIntervalId);
	}

	private stopSyncLoop(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	hasCompleteGitHubSettings(): boolean {
		const s = this.settings;
		return s.githubOwner.length > 0 && s.githubRepo.length > 0 && s.githubToken.length > 0;
	}

	private getGitHubClient(): GitHubClient {
		if (!this.hasCompleteGitHubSettings()) {
			throw new Error("GitHub owner, repository, and token must be configured in settings first.");
		}
		return new GitHubClient({
			token: this.settings.githubToken,
			owner: this.settings.githubOwner,
			repo: this.settings.githubRepo,
			branch: this.settings.githubBranch,
		});
	}

	async testGitHubConnection(): Promise<void> {
		await this.getGitHubClient().testConnection();
	}

	promptForPassword(): void {
		new PasswordModal(this.app, "Unlock OCSync", (password) => {
			void this.unlockWithPassword(password);
		}).open();
	}

	/**
	 * Fetches (or creates, on first run) the PBKDF2 salt from the repo and
	 * derives the session key from it. A wrong password will not fail here -
	 * PBKDF2 always succeeds - it only surfaces later as a failed AES-GCM
	 * authentication when we try to decrypt something.
	 */
	private async unlockWithPassword(password: string): Promise<void> {
		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			let saltBytes: Uint8Array;
			const existing = await client.getFile(SALT_PATH);
			if (existing) {
				const saltBase64Text = contentBase64ToText(existing.contentBase64);
				saltBytes = base64ToBytes(saltBase64Text);
			} else {
				saltBytes = generateSalt();
				const saltBase64Text = bytesToBase64(saltBytes);
				await client.putFile(SALT_PATH, textToContentBase64(saltBase64Text), "ocsync: initialize salt");
				new Notice("OCSync: initialized new encryption salt in repository");
			}

			this.sessionKey = await deriveKey(password, saltBytes);
			this.setStatus("idle");
			new Notice("OCSync: unlocked");
			this.restartSyncLoop();
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: failed to unlock - ${(e as Error).message}`);
		}
	}

	/**
	 * Phase 1 connectivity test: encrypts the active file and pushes it to a
	 * throwaway test path. This does not build a manifest or content-addressed
	 * object store yet - that lands in Phase 2. There is no decrypt/pull path
	 * yet either.
	 */
	async manualSyncActiveFile(): Promise<void> {
		if (!this.sessionKey) {
			new Notice("OCSync: unlock your encryption password first");
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("OCSync: no active file to sync");
			return;
		}

		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			const plaintext = await this.app.vault.readBinary(file);
			const combined = await encryptBytes(this.sessionKey, plaintext);

			const remotePath = `ocsync-test/${file.path}.enc`;
			const existing = await client.getFile(remotePath).catch(() => null);
			await client.putFile(
				remotePath,
				bytesToBase64(combined),
				`ocsync: test push ${file.path}`,
				existing?.sha
			);

			this.setStatus("ok");
			new Notice(`OCSync: pushed encrypted "${file.path}" to GitHub`);
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: sync failed - ${(e as Error).message}`);
		}
	}

	/**
	 * Bidirectional sync: pushes local changes, pulls remote changes,
	 * propagates deletions via tombstones, and writes " (conflict ...)"
	 * copies instead of silently overwriting when both sides changed the
	 * same file. Called by the settings "Sync now" button, the command
	 * palette, and the automatic background timer (`auto: true`, which
	 * suppresses the "already up to date" notice to avoid spamming the user
	 * every sync interval).
	 */
	async syncNow(auto = false): Promise<void> {
		if (!this.sessionKey) {
			if (!auto) new Notice("OCSync: unlock your encryption password first");
			return;
		}
		if (this.isSyncing) {
			if (!auto) new Notice("OCSync: a sync is already in progress");
			return;
		}
		const sessionKey = this.sessionKey;

		this.isSyncing = true;
		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			const summary = await runSync(this.app, client, sessionKey, this.settings.excludePatterns, this.localState);
			await this.saveLocalState();

			if (summary.pullErrors.length > 0) {
				this.setStatus("error");
				new Notice(
					`OCSync: sync finished with ${summary.pullErrors.length} error(s) - see first: ${summary.pullErrors[0].path}: ${summary.pullErrors[0].message}`
				);
			} else {
				this.setStatus("ok");
			}

			if (summary.noChanges && summary.pullErrors.length === 0) {
				if (!auto) new Notice("OCSync: already up to date");
			} else {
				const parts: string[] = [];
				if (summary.pushedPaths.length) parts.push(`${summary.pushedPaths.length} pushed`);
				if (summary.pulledPaths.length) parts.push(`${summary.pulledPaths.length} pulled`);
				if (summary.deletedLocalPaths.length) parts.push(`${summary.deletedLocalPaths.length} deleted locally`);
				if (summary.conflicts.length) parts.push(`${summary.conflicts.length} conflict(s)`);
				if (summary.tombstonesPurged) parts.push(`${summary.tombstonesPurged} tombstone(s) purged`);
				if (parts.length > 0) new Notice(`OCSync: ${parts.join(", ")}`);
				for (const c of summary.conflicts) {
					new Notice(`OCSync: conflict on "${c.path}" - remote version saved as "${c.conflictPath}"`);
				}
			}
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: sync failed - ${(e as Error).message}`);
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Phase 2: scans the entire vault, builds a content-addressed object
	 * store (objects/<sha256>.enc) plus an encrypted manifest, and pushes
	 * everything in a single atomic commit via the Git Data API. Push-only -
	 * kept as a debug command; superseded by the bidirectional syncNow().
	 */
	async pushFullVault(): Promise<void> {
		if (!this.sessionKey) {
			new Notice("OCSync: unlock your encryption password first");
			return;
		}
		const sessionKey = this.sessionKey;

		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			const [scanned, remoteManifestFile] = await Promise.all([
				scanVault(this.app, this.settings.excludePatterns),
				client.getFile(MANIFEST_PATH),
			]);

			let remoteManifest: Manifest;
			if (remoteManifestFile) {
				remoteManifest = await decryptManifest(sessionKey, base64ToBytes(remoteManifestFile.contentBase64));
			} else {
				remoteManifest = emptyManifest();
			}

			const knownObjectHashes = new Set(Object.values(remoteManifest.files).map((f) => f.objectHash));

			const newManifest: Manifest = {
				version: remoteManifest.version,
				files: { ...remoteManifest.files },
			};
			for (const file of scanned) {
				newManifest.files[file.path] = {
					objectHash: file.hash,
					mtime: file.mtime,
					size: file.size,
					deleted: false,
				};
			}

			const seenThisRun = new Set<string>();
			const objectBlobs: PendingBlob[] = [];
			for (const file of scanned) {
				if (knownObjectHashes.has(file.hash) || seenThisRun.has(file.hash)) continue;
				seenThisRun.add(file.hash);
				const encrypted = await encryptBytes(sessionKey, file.data);
				objectBlobs.push({ path: `objects/${file.hash}.enc`, contentBase64: bytesToBase64(encrypted) });
			}

			const encryptedManifest = await encryptManifest(sessionKey, newManifest);
			const blobs: PendingBlob[] = [
				{ path: MANIFEST_PATH, contentBase64: bytesToBase64(encryptedManifest) },
				...objectBlobs,
			];

			await commitChanges(client, `ocsync: sync ${scanned.length} files (${objectBlobs.length} new objects)`, blobs);

			this.localState.lastSyncedFiles = {};
			for (const file of scanned) {
				this.localState.lastSyncedFiles[file.path] = {
					hash: file.hash,
					mtime: file.mtime,
					size: file.size,
				};
			}
			await this.saveLocalState();

			this.setStatus("ok");
			new Notice(`OCSync: pushed ${scanned.length} files (${objectBlobs.length} new objects uploaded)`);
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: sync failed - ${(e as Error).message}`);
		}
	}

	private setStatus(status: SyncStatus): void {
		this.status = status;
		if (!this.statusBarItem) return;
		const icons: Record<SyncStatus, string> = {
			locked: "🔒",
			idle: "⚡",
			syncing: "⏳",
			ok: "✅",
			error: "❌",
		};
		this.statusBarItem.setText(`${icons[this.status]} OCSync`);
	}
}
