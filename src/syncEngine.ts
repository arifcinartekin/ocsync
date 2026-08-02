import { App, TFile } from "obsidian";
import { base64ToBytes, bytesToBase64, decryptBytes, encryptBytes, sha256Hex } from "./crypto";
import { conflictCopyPath } from "./conflict";
import { decideAction } from "./decideAction";
import { GitHubClient } from "./github";
import { commitChanges, PendingBlob } from "./gitCommit";
import { decryptManifest, encryptManifest } from "./manifest";
import { LocalFileState, LocalSyncState, Manifest, ManifestFileEntry, emptyManifest } from "./types";
import { scanVault } from "./vaultScanner";
import { writeLocalFile } from "./vaultWrite";
import { mapWithConcurrency } from "./concurrency";

const MANIFEST_PATH = "manifest.enc";
const DOWNLOAD_CONCURRENCY = 6;

/** A short, non-sensitive fingerprint of ciphertext bytes for log-comparison across pushes/reads. */
async function shortDigest(contentBase64: string): Promise<string> {
	const bytes = base64ToBytes(contentBase64);
	const hex = await sha256Hex(bytes.buffer as ArrayBuffer);
	return `${bytes.length}b/${hex.slice(0, 12)}`;
}

/**
 * GitHub's Contents API (used to read manifest.enc) can lag a few seconds
 * behind writes made via the Git Data API (used to commit). A decrypt
 * failure right after a push is more likely to be that staleness than an
 * actual wrong key, so we re-fetch and retry once before giving up.
 */
export async function fetchAndDecryptManifest(
	client: GitHubClient,
	sessionKey: CryptoKey,
	onLog?: (msg: string) => void
): Promise<Manifest> {
	const first = await client.getFile(MANIFEST_PATH);
	if (!first) return emptyManifest();
	onLog?.(`Fetched manifest.enc (${await shortDigest(first.contentBase64)})`);
	try {
		return await decryptManifest(sessionKey, base64ToBytes(first.contentBase64));
	} catch (firstError) {
		onLog?.("Decrypt failed on first read, retrying fetch once...");
		await new Promise((resolve) => setTimeout(resolve, 2500));
		const second = await client.getFile(MANIFEST_PATH);
		if (!second) return emptyManifest();
		onLog?.(`Re-fetched manifest.enc (${await shortDigest(second.contentBase64)})`);
		try {
			return await decryptManifest(sessionKey, base64ToBytes(second.contentBase64));
		} catch {
			throw firstError;
		}
	}
}

/** How long a deletion tombstone stays in the manifest before being purged. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConflictEvent {
	path: string;
	conflictPath: string;
}

export interface SyncSummary {
	pushedPaths: string[];
	pulledPaths: string[];
	deletedLocalPaths: string[];
	conflicts: ConflictEvent[];
	pullErrors: { path: string; message: string }[];
	commitSha: string | null;
	tombstonesPurged: number;
	noChanges: boolean;
}

interface PushAction {
	path: string;
	objectHash: string;
	mtime: number;
	size: number;
	deleted: boolean;
	uploadData: ArrayBuffer | null;
}

export async function runSync(
	app: App,
	client: GitHubClient,
	sessionKey: CryptoKey,
	excludePatterns: string[],
	localState: LocalSyncState,
	onLog?: (msg: string) => void
): Promise<SyncSummary> {
	const scanned = await scanVault(app, excludePatterns);
	const scannedByPath = new Map(scanned.map((f) => [f.path, f]));

	const remoteManifest: Manifest = await fetchAndDecryptManifest(client, sessionKey, onLog);

	const knownObjectHashes = new Set(Object.values(remoteManifest.files).map((f) => f.objectHash));

	const allPaths = new Set<string>([
		...scannedByPath.keys(),
		...Object.keys(remoteManifest.files),
		...Object.keys(localState.lastSyncedFiles),
	]);

	const pushActions: PushAction[] = [];
	const pullPaths: string[] = [];
	const deleteLocalPaths: string[] = [];
	const dropCachePaths: string[] = [];
	const conflicts: ConflictEvent[] = [];
	const pullErrors: { path: string; message: string }[] = [];
	const converged = new Map<string, LocalFileState>();

	for (const path of allPaths) {
		const local = scannedByPath.get(path);
		const remote = remoteManifest.files[path];
		const known = localState.lastSyncedFiles[path];

		const decision = decideAction(local, remote, known);

		switch (decision.type) {
			case "none":
				if (local) converged.set(path, { hash: local.hash, mtime: local.mtime, size: local.size });
				break;
			case "push":
				if (local) {
					pushActions.push({
						path,
						objectHash: local.hash,
						mtime: local.mtime,
						size: local.size,
						deleted: false,
						uploadData: local.data,
					});
				}
				break;
			case "push-tombstone":
				pushActions.push({
					path,
					objectHash: known?.hash ?? "",
					mtime: Date.now(),
					size: 0,
					deleted: true,
					uploadData: null,
				});
				break;
			case "pull":
				pullPaths.push(path);
				break;
			case "delete-local":
				deleteLocalPaths.push(path);
				break;
			case "drop-cache":
				dropCachePaths.push(path);
				break;
			case "conflict":
				if (local && remote) conflicts.push({ path, conflictPath: conflictCopyPath(path) });
				break;
		}
	}

	// Resolve pulls (including the "remote wins" half of each conflict) by
	// downloading and decrypting the remote object, then writing it locally.
	const objectsNeeded = new Map<string, string>(); // objectHash -> a path referencing it (for error attribution)
	for (const path of pullPaths) objectsNeeded.set(remoteManifest.files[path].objectHash, path);
	for (const c of conflicts) objectsNeeded.set(remoteManifest.files[c.path].objectHash, c.conflictPath);

	const downloadedObjects = new Map<string, ArrayBuffer>();
	await mapWithConcurrency(Array.from(objectsNeeded.entries()), DOWNLOAD_CONCURRENCY, async ([hash, contextPath]) => {
		try {
			const remoteObject = await client.getFile(`objects/${hash}.enc`);
			if (!remoteObject) throw new Error(`missing object ${hash} referenced by manifest`);
			const combined = base64ToBytes(remoteObject.contentBase64);
			const plaintext = await decryptBytes(sessionKey, combined);
			downloadedObjects.set(hash, plaintext);
		} catch (e) {
			pullErrors.push({ path: contextPath, message: (e as Error).message });
		}
	});

	const pulledPaths: string[] = [];
	for (const path of pullPaths) {
		const hash = remoteManifest.files[path].objectHash;
		const data = downloadedObjects.get(hash);
		if (!data) continue;
		try {
			await writeLocalFile(app, path, data);
			pulledPaths.push(path);
			converged.set(path, { hash, mtime: remoteManifest.files[path].mtime, size: remoteManifest.files[path].size });
		} catch (e) {
			pullErrors.push({ path, message: (e as Error).message });
		}
	}

	const resolvedConflicts: ConflictEvent[] = [];
	for (const c of conflicts) {
		const remoteEntry = remoteManifest.files[c.path];
		const data = downloadedObjects.get(remoteEntry.objectHash);
		if (!data) continue;
		try {
			await writeLocalFile(app, c.conflictPath, data);
			resolvedConflicts.push(c);

			pushActions.push({
				path: c.conflictPath,
				objectHash: remoteEntry.objectHash,
				mtime: Date.now(),
				size: data.byteLength,
				deleted: false,
				uploadData: null,
			});
			converged.set(c.conflictPath, { hash: remoteEntry.objectHash, mtime: Date.now(), size: data.byteLength });

			const local = scannedByPath.get(c.path);
			if (local) converged.set(c.path, { hash: local.hash, mtime: local.mtime, size: local.size });
		} catch (e) {
			pullErrors.push({ path: c.conflictPath, message: (e as Error).message });
		}
	}

	// Apply confirmed remote deletions locally (only reached when the local
	// copy was unchanged since the last sync - see decideAction).
	const deletedLocalPaths: string[] = [];
	for (const path of deleteLocalPaths) {
		const file = app.vault.getAbstractFileByPath(path);
		try {
			if (file instanceof TFile) await app.vault.trash(file, false);
			deletedLocalPaths.push(path);
		} catch (e) {
			pullErrors.push({ path, message: (e as Error).message });
		}
	}

	// Stage new objects for anything being pushed.
	const seenThisRun = new Set<string>();
	const objectBlobs: PendingBlob[] = [];
	for (const action of pushActions) {
		if (action.uploadData === null) continue;
		if (knownObjectHashes.has(action.objectHash) || seenThisRun.has(action.objectHash)) continue;
		seenThisRun.add(action.objectHash);
		const encrypted = await encryptBytes(sessionKey, action.uploadData);
		objectBlobs.push({ path: `objects/${action.objectHash}.enc`, contentBase64: bytesToBase64(encrypted) });
	}

	const newManifestFiles: Record<string, ManifestFileEntry> = { ...remoteManifest.files };
	for (const action of pushActions) {
		newManifestFiles[action.path] = {
			objectHash: action.objectHash,
			mtime: action.mtime,
			size: action.size,
			deleted: action.deleted,
		};
		converged.set(action.path, { hash: action.objectHash, mtime: action.mtime, size: action.size });
	}

	let tombstonesPurged = 0;
	for (const [path, entry] of Object.entries(newManifestFiles)) {
		if (entry.deleted && Date.now() - entry.mtime > TOMBSTONE_RETENTION_MS) {
			delete newManifestFiles[path];
			tombstonesPurged++;
		}
	}

	const manifestChanged = pushActions.length > 0 || tombstonesPurged > 0;

	let commitSha: string | null = null;
	if (manifestChanged) {
		const newManifest: Manifest = { version: remoteManifest.version, files: newManifestFiles };
		const encryptedManifest = await encryptManifest(sessionKey, newManifest);
		const manifestContentBase64 = bytesToBase64(encryptedManifest);
		onLog?.(`Pushing manifest.enc (${await shortDigest(manifestContentBase64)})`);
		const blobs: PendingBlob[] = [{ path: MANIFEST_PATH, contentBase64: manifestContentBase64 }, ...objectBlobs];
		commitSha = await commitChanges(
			client,
			`ocsync: sync (${pushActions.length} changed, ${pulledPaths.length} pulled, ` +
				`${resolvedConflicts.length} conflicts, ${tombstonesPurged} tombstones purged)`,
			blobs
		);
		onLog?.(`Commit ${commitSha?.slice(0, 8)} created`);
	}

	for (const [path, state] of converged) {
		localState.lastSyncedFiles[path] = state;
	}
	for (const path of [...dropCachePaths, ...deletedLocalPaths]) {
		delete localState.lastSyncedFiles[path];
	}

	return {
		pushedPaths: pushActions.map((a) => a.path),
		pulledPaths,
		deletedLocalPaths,
		conflicts: resolvedConflicts,
		pullErrors,
		commitSha,
		tombstonesPurged,
		noChanges:
			pushActions.length === 0 &&
			pulledPaths.length === 0 &&
			resolvedConflicts.length === 0 &&
			deletedLocalPaths.length === 0,
	};
}
