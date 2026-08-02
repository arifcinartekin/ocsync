# OCSync

**End-to-end encrypted, GitHub-backed bidirectional sync for [Obsidian](https://obsidian.md).**

OCSync turns any private GitHub repository into an encrypted sync backend for an Obsidian vault. Every note is encrypted on-device before it ever leaves your computer or phone; GitHub only ever stores opaque, content-addressed ciphertext blobs. There's no third-party sync service, no server to run, and no plaintext note content or file names ever cross the network.

> Personal project, not published to the Obsidian community plugin store. Built as an exploration of client-side encryption, content-addressed storage, and building a correct offline-first sync engine on top of a REST API that was never designed to be one.

## Why

Obsidian Sync and most third-party sync plugins either cost a subscription, require a self-hosted server, or trust a cloud provider with plaintext notes. OCSync only needs a free private GitHub repo and a password you choose - GitHub stores encrypted bytes it cannot read.

## Features

- **Client-side AES-256-GCM encryption** of every note, keyed by a password only you know. The password is never written to disk - it lives in memory for the session and is re-entered from the plugin's settings tab.
- **Content-addressed object storage**: files are stored as `objects/<sha256>.enc`, so identical content (even across different notes) is only ever stored once.
- **Hidden file names and folder structure**: the repo contains an encrypted manifest mapping paths to content hashes - GitHub never sees your note titles or vault layout.
- **True bidirectional sync** with a conservative three-way diff (local vs. last-known-synced vs. remote). Edits always win over deletions; anything genuinely ambiguous becomes a `Note (conflict TIMESTAMP).md` copy instead of a silent overwrite.
- **Deletion propagation via tombstones** with a 30-day retention window, so deleting a note on one device removes it everywhere without resurrecting deleted files as "ghosts."
- **Runs on desktop and mobile (iOS/Android) from one codebase** - no `child_process`, no bundled `git` binary, no native modules. All GitHub interaction is plain `fetch()` against the REST API; all crypto is the standard Web Crypto API (`crypto.subtle`).
- **Automatic background sync** (default every 60s, configurable) with rate-limit backoff and no empty commits.

## How it works

### Repository layout

```
your-private-repo/
  salt.txt              # PBKDF2 salt, plaintext base64 - not secret, the key derived from it is
  manifest.enc           # encrypted JSON: { "Folder/Note.md": { objectHash, mtime, size, deleted } }
  objects/
    <sha256>.enc          # one file's encrypted content, named by its plaintext content hash
    <sha256>.enc
```

### Encryption

- Key derivation: **PBKDF2-SHA256, 250,000 iterations**, salted per-repository.
- Content encryption: **AES-256-GCM**, random IV per object, IV+ciphertext stored together.
- The password is asked for once per Obsidian session (Settings tab, not persisted) and never appears in a log message, error, or `data.json`.

### Sync algorithm

Every cycle (manual or on the timer):

1. Scan the local vault, hashing every included file (SHA-256 of plaintext).
2. Fetch and decrypt the remote manifest.
3. For every path, compare **local vs. last-known-synced-state vs. remote** and decide: push, pull, propagate a deletion, or - if both sides changed since the last sync - write a conflict copy and push both versions forward.
4. Batch every change (new objects + the updated manifest) into a **single atomic commit** via the Git Data API (`blobs` → `tree` → `commit` → `ref update`), so a sync cycle never leaves the repo in a half-written state.

Reads (manifest + objects) also go through the Git Data API rather than GitHub's Contents API - the Contents API is backed by a separate caching layer that was observed serving stale data up to a minute after a commit, which is fatal for a tight sync loop.

### Conflict & deletion matrix

The core decision logic (`decideAction`) is a pure function with zero Obsidian dependency, covering every combination of local/remote edit and delete:

| Local | Remote | Last known | Result |
|---|---|---|---|
| edited | unchanged | - | push |
| unchanged | edited | - | pull |
| edited | edited (differently) | - | conflict copy |
| deleted | unchanged | - | tombstone (propagate delete) |
| deleted | edited after | - | **resurrect locally** (edits always outrank deletes) |
| exists, unchanged | tombstoned | - | delete locally |
| exists, edited | tombstoned | - | **push wins** (resurrects remotely) |

Covered by `scripts/test-decide-action.mjs` (`npm test`) - 16 scenarios, run in plain Node with no Obsidian dependency.

## Installation

This plugin is **not** on the community plugin store, so mobile installation goes through [BRAT](https://github.com/TfTHacker/obsidian42-brat):

**Desktop**: copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/ocsync/`, then enable it in Settings → Community plugins.

**iOS / Android**: install BRAT from the community plugin browser, then in BRAT's settings choose "Add Beta plugin" and paste this repo's URL.

## Setup

1. Create a private GitHub repository dedicated to this vault's encrypted data.
2. Create a **fine-grained Personal Access Token** scoped to only that repository, with **Contents: Read and write** permission - nothing else.
3. In OCSync's settings: enter the repo owner/name/branch and the token, then unlock with an encryption password of your choice.
4. Repeat on every device you want synced, pointing at the same repo with the same password.

## Development

```
npm install
npm run dev        # esbuild watch mode
npm run build       # typecheck + production build
npm test            # decideAction scenario tests
```

## Security notes

- The encryption password is never persisted anywhere and never appears in logs or error messages.
- The GitHub token *is* stored in the plugin's local `data.json` by design (same tradeoff every git-credential-using tool makes) - hence the fine-grained, single-repo, contents-only scope recommendation above.
- File names, folder structure, and file count are hidden from GitHub; only content hashes and ciphertext are visible.
- This is a personal project and has not had a formal security audit. Read the source before trusting it with anything sensitive.

## Non-goals

- Not real-time sync - this polls on an interval (default 60s), it does not use webhooks/websockets.
- Not published to the Obsidian community plugin store.
- Not a general-purpose git client - it only understands the narrow object/manifest structure it creates.

## License

MIT
