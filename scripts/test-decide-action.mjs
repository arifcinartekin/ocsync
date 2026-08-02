// Standalone test for the core sync decision matrix (src/decideAction.ts).
// Deliberately dependency-free (no test framework) and runs in plain Node,
// since decideAction.ts has no Obsidian runtime dependency - it's the one
// module we can meaningfully unit-test outside of Obsidian itself.
//
// Run with: npm test

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import esbuild from "esbuild";

const result = await esbuild.build({
	entryPoints: ["src/decideAction.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});

const tmpDir = mkdtempSync(path.join(tmpdir(), "ocsync-test-"));
const tmpFile = path.join(tmpDir, "decideAction.mjs");
writeFileSync(tmpFile, result.outputFiles[0].text);
const { decideAction } = await import(`file://${tmpFile}`);

let passed = 0;
function check(name, local, remote, known, expectedType) {
	const decision = decideAction(local, remote, known);
	assert.equal(decision.type, expectedType, `${name}: expected "${expectedType}", got "${decision.type}"`);
	passed++;
	console.log(`ok - ${name}`);
}

const fileA = (hash) => ({ path: "note.md", mtime: 1, size: 1, hash, data: new ArrayBuffer(0) });
const remoteEntry = (hash, deleted = false) => ({ objectHash: hash, mtime: 1, size: 1, deleted });
const knownState = (hash) => ({ hash, mtime: 1, size: 1 });

// --- No history / brand new files ---
check("brand new local file, nothing remote", fileA("h1"), undefined, undefined, "push");
check("brand new remote file, nothing local", undefined, remoteEntry("h1"), undefined, "pull");
check("nothing anywhere is a no-op", undefined, undefined, undefined, "none");

// --- First-ever sync of a path that exists on both sides already ---
check("first sync, local and remote already match", fileA("h1"), remoteEntry("h1"), undefined, "none");
check(
	"first sync, local and remote differ with no known base -> conflict, never silently pick one",
	fileA("local-h"),
	remoteEntry("remote-h"),
	undefined,
	"conflict"
);

// --- Normal edits after at least one prior sync ---
check("only local edited since last sync", fileA("new-h"), remoteEntry("old-h"), knownState("old-h"), "push");
check("only remote edited since last sync", fileA("old-h"), remoteEntry("new-h"), knownState("old-h"), "pull");
check(
	"both devices edited the same file since last sync -> conflict copy, no data loss",
	fileA("local-h"),
	remoteEntry("remote-h"),
	knownState("base-h"),
	"conflict"
);
check("both sides converged to the same content", fileA("same-h"), remoteEntry("same-h"), knownState("old-h"), "none");

// --- Deletions (Phase 4 tombstones) ---
check(
	"local deletion, remote unchanged since last sync -> propagate as tombstone",
	undefined,
	remoteEntry("h1"),
	knownState("h1"),
	"push-tombstone"
);
check(
	"local deletion but remote was edited after our last sync -> resurrect locally, edits outrank deletes",
	undefined,
	remoteEntry("new-h"),
	knownState("old-h"),
	"pull"
);
check(
	"remote tombstone, local file untouched since last sync -> honor the deletion locally",
	fileA("h1"),
	remoteEntry("h1", true),
	knownState("h1"),
	"delete-local"
);
check(
	"remote tombstone, but local file was edited after last sync -> local edit wins, resurrects remotely",
	fileA("edited-h"),
	remoteEntry("h1", true),
	knownState("h1"),
	"push"
);
check(
	"remote tombstone, brand new local file at that path -> just push it, ignore the old tombstone",
	fileA("h1"),
	remoteEntry("old-h", true),
	undefined,
	"push"
);
check("both sides agree the file is gone -> drop it from local cache", undefined, remoteEntry("h1", true), knownState("h1"), "drop-cache");
check(
	"stale local cache entry for a path gone on both sides",
	undefined,
	undefined,
	knownState("h1"),
	"drop-cache"
);

console.log(`\n${passed} scenario(s) passed.`);
