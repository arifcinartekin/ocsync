export const MANIFEST_VERSION = 1;

export interface ManifestFileEntry {
	objectHash: string;
	mtime: number;
	size: number;
	deleted: boolean;
}

export interface Manifest {
	version: number;
	files: Record<string, ManifestFileEntry>;
}

export function emptyManifest(): Manifest {
	return { version: MANIFEST_VERSION, files: {} };
}

/** What we knew about each local file as of the last successful sync. */
export interface LocalFileState {
	hash: string;
	mtime: number;
	size: number;
}

export interface LocalSyncState {
	lastSyncedFiles: Record<string, LocalFileState>;
}

export const DEFAULT_LOCAL_STATE: LocalSyncState = {
	lastSyncedFiles: {},
};
