import { App } from "obsidian";
import { base64ToBytes, bytesToBase64, decryptBytes, encryptBytes } from "./crypto";
import { conflictCopyPath } from "./conflict";
import { GitHubClient } from "./github";
import { commitChanges, PendingBlob } from "./gitCommit";
import { decryptManifest, encryptManifest } from "./manifest";
import { LocalFileState, LocalSyncState, Manifest, ManifestFileEntry, emptyManifest } from "./types";
import { ScannedFile, scanVault } from "./vaultScanner";
import { writeLocalFile } from "./vaultWrite";
import { mapWithConcurrency } from "./concurrency";

const MANIFEST_PATH = "manifest.enc";
const DOWNLOAD_CONCURRENCY = 6;

export type SyncActionType = "push" | "pull" | "conflict" | "none";

export interface ConflictEvent {
	path: string;
	conflictPath: string;
}

export interface SyncSummary {
	pushedPaths: string[];
	pulledPaths: string[];
	conflicts: ConflictEvent[];
	pullErrors: { path: string; message: string }[];
	commitSha: string | null;
	noChanges: boolean;
}

/**
 * Three-way decision per path: compares the current local file against what
 * we last knew was in sync, and against the current remote manifest entry.
 * Deliberately conservative - anything ambiguous becomes a conflict rather
 * than risking silent data loss.
 */
export function decideAction(
	local: ScannedFile | undefined,
	remote: ManifestFileEntry | undefined,
	known: LocalFileState | undefined
): SyncActionType | "local-deleted" {
	const remoteHash = remote && !remote.deleted ? remote.objectHash : undefined;

	if (!local) {
		// Local deletion propagation is handled in Phase 4 (tombstones). For
		// now: a path with no local file and no prior known state is simply
		// something that only exists remotely -> pull it down.
		if (!known) return remoteHash ? "pull" : "none";
		return "local-deleted";
	}

	if (!remoteHash) {
		// Never pushed before, or the remote entry disappeared - keep the
		// local copy safe by pushing it.
		return "push";
	}

	if (local.hash === remoteHash) return "none";

	if (!known) return "conflict";

	const localChanged = local.hash !== known.hash;
	const remoteChanged = remoteHash !== known.hash;

	if (localChanged && !remoteChanged) return "push";
	if (!localChanged && remoteChanged) return "pull";
	return "conflict";
}

export async function runSync(
	app: App,
	client: GitHubClient,
	sessionKey: CryptoKey,
	excludePatterns: string[],
	localState: LocalSyncState
): Promise<SyncSummary> {
	const scanned = await scanVault(app, excludePatterns);
	const scannedByPath = new Map(scanned.map((f) => [f.path, f]));

	const remoteManifestFile = await client.getFile(MANIFEST_PATH);
	const remoteManifest: Manifest = remoteManifestFile
		? await decryptManifest(sessionKey, base64ToBytes(remoteManifestFile.contentBase64))
		: emptyManifest();

	const knownObjectHashes = new Set(Object.values(remoteManifest.files).map((f) => f.objectHash));

	const allPaths = new Set<string>([
		...scannedByPath.keys(),
		...Object.keys(remoteManifest.files),
		...Object.keys(localState.lastSyncedFiles),
	]);

	interface PushAction {
		path: string;
		objectHash: string;
		mtime: number;
		size: number;
		uploadData: ArrayBuffer | null;
	}
	const pushActions: PushAction[] = [];
	const pullPaths: string[] = [];
	const conflicts: ConflictEvent[] = [];
	const pullErrors: { path: string; message: string }[] = [];
	const converged = new Map<string, LocalFileState>();
	const droppedFromCache: string[] = [];

	for (const path of allPaths) {
		const local = scannedByPath.get(path);
		const remote = remoteManifest.files[path];
		const known = localState.lastSyncedFiles[path];

		const action = decideAction(local, remote, known);

		switch (action) {
			case "none":
				if (local) converged.set(path, { hash: local.hash, mtime: local.mtime, size: local.size });
				break;
			case "local-deleted":
				// Deletion propagation lands in Phase 4. Leave the cached state
				// untouched so this stays consistent until then.
				break;
			case "push":
				if (local) {
					pushActions.push({
						path,
						objectHash: local.hash,
						mtime: local.mtime,
						size: local.size,
						uploadData: local.data,
					});
				}
				break;
			case "pull":
				pullPaths.push(path);
				break;
			case "conflict":
				if (local && remote) {
					conflicts.push({ path, conflictPath: conflictCopyPath(path) });
				}
				break;
		}

		if (!local && !remote && known) {
			droppedFromCache.push(path);
		}
	}

	// Resolve pulls (including the "remote wins" half of each conflict) by
	// downloading and decrypting the remote object, then writing it locally.
	const objectsNeeded = new Map<string, string>(); // objectHash -> a path that needs it (for error messages)
	for (const path of pullPaths) {
		const hash = remoteManifest.files[path].objectHash;
		objectsNeeded.set(hash, path);
	}
	for (const c of conflicts) {
		const hash = remoteManifest.files[c.path].objectHash;
		objectsNeeded.set(hash, c.conflictPath);
	}

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
		if (!data) continue; // already recorded in pullErrors
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
		if (!data) continue; // already recorded in pullErrors
		try {
			await writeLocalFile(app, c.conflictPath, data);
			resolvedConflicts.push(c);

			// The remote version now lives at conflictPath - reference the
			// already-uploaded object, no new blob upload needed.
			pushActions.push({
				path: c.conflictPath,
				objectHash: remoteEntry.objectHash,
				mtime: Date.now(),
				size: data.byteLength,
				uploadData: null,
			});
			converged.set(c.conflictPath, { hash: remoteEntry.objectHash, mtime: Date.now(), size: data.byteLength });

			// The local version keeps its own path and gets pushed as-is.
			const local = scannedByPath.get(c.path);
			if (local) {
				converged.set(c.path, { hash: local.hash, mtime: local.mtime, size: local.size });
			}
		} catch (e) {
			pullErrors.push({ path: c.conflictPath, message: (e as Error).message });
		}
	}

	// Stage new objects and build the updated manifest for anything being pushed.
	const seenThisRun = new Set<string>();
	const objectBlobs: PendingBlob[] = [];
	for (const action of pushActions) {
		if (action.uploadData === null) continue;
		if (knownObjectHashes.has(action.objectHash) || seenThisRun.has(action.objectHash)) continue;
		seenThisRun.add(action.objectHash);
		const encrypted = await encryptBytes(sessionKey, action.uploadData);
		objectBlobs.push({ path: `objects/${action.objectHash}.enc`, contentBase64: bytesToBase64(encrypted) });
	}

	let commitSha: string | null = null;
	if (pushActions.length > 0) {
		const newManifest: Manifest = { version: remoteManifest.version, files: { ...remoteManifest.files } };
		for (const action of pushActions) {
			newManifest.files[action.path] = {
				objectHash: action.objectHash,
				mtime: action.mtime,
				size: action.size,
				deleted: false,
			};
			converged.set(action.path, { hash: action.objectHash, mtime: action.mtime, size: action.size });
		}

		const encryptedManifest = await encryptManifest(sessionKey, newManifest);
		const blobs: PendingBlob[] = [
			{ path: MANIFEST_PATH, contentBase64: bytesToBase64(encryptedManifest) },
			...objectBlobs,
		];
		commitSha = await commitChanges(
			client,
			`ocsync: sync (${pushActions.length} changed, ${pulledPaths.length} pulled, ${resolvedConflicts.length} conflicts)`,
			blobs
		);
	}

	// Update the local "last known synced" cache to the converged state.
	for (const [path, state] of converged) {
		localState.lastSyncedFiles[path] = state;
	}
	for (const path of droppedFromCache) {
		delete localState.lastSyncedFiles[path];
	}

	return {
		pushedPaths: pushActions.map((a) => a.path),
		pulledPaths,
		conflicts: resolvedConflicts,
		pullErrors,
		commitSha,
		noChanges: pushActions.length === 0 && pulledPaths.length === 0 && resolvedConflicts.length === 0,
	};
}
