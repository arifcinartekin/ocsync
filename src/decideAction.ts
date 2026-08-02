import { LocalFileState, ManifestFileEntry, ScannedFile } from "./types";

export type Decision =
	| { type: "none" }
	| { type: "push" }
	| { type: "push-tombstone" }
	| { type: "pull" }
	| { type: "delete-local" }
	| { type: "conflict" }
	| { type: "drop-cache" };

/**
 * Total decision function covering edits, new files, and deletions on both
 * sides. Deliberately conservative wherever intent is ambiguous: an edit
 * always outranks a deletion (so a device that deleted a file while another
 * device kept editing it will have the edited version resurrected locally
 * rather than losing the edit), and anything else ambiguous becomes a
 * conflict copy rather than a silent overwrite.
 *
 * Pure and free of any Obsidian dependency on purpose - see
 * scripts/test-decide-action.mjs, which exercises this in plain Node.
 */
export function decideAction(
	local: ScannedFile | undefined,
	remote: ManifestFileEntry | undefined,
	known: LocalFileState | undefined
): Decision {
	const remoteActive = remote && !remote.deleted;
	const remoteDeleted = remote !== undefined && remote.deleted === true;
	const remoteHash = remoteActive ? remote!.objectHash : undefined;

	if (local) {
		if (remoteActive) {
			if (local.hash === remoteHash) return { type: "none" };
			if (!known) return { type: "conflict" };
			const localChanged = local.hash !== known.hash;
			const remoteChanged = remoteHash !== known.hash;
			if (localChanged && !remoteChanged) return { type: "push" };
			if (!localChanged && remoteChanged) return { type: "pull" };
			return { type: "conflict" };
		}
		if (remoteDeleted) {
			if (!known) return { type: "push" };
			if (local.hash === known.hash) return { type: "delete-local" };
			return { type: "push" };
		}
		return { type: "push" };
	}

	// No local file.
	if (remoteActive) {
		if (!known) return { type: "pull" };
		const remoteChanged = remoteHash !== known.hash;
		if (remoteChanged) return { type: "pull" };
		return { type: "push-tombstone" };
	}
	if (remoteDeleted) return { type: "drop-cache" };
	if (known) return { type: "drop-cache" };
	return { type: "none" };
}
