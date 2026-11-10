# Storage and sync for a local-first notes app

Chosen as the baseline's widest win. Problem `local-first-sync`.

## Problem

Two developers are building a local-first notes app: text notes with attachments up to 10 MB, on phones and laptops, fully usable offline. They have no server today and want none for the first release, but they plan to offer a paid hosted sync service within a year. Customers will often edit the same note on two devices before either has connected, and they expect not to lose text when that happens.

Recommend how the app should store data on the device and how it should sync, how concurrent edits are reconciled and what the user sees when they conflict, and how the team gets from "no server" to a hosted sync service without existing users having to migrate anything. Name the risks of your recommendation and how the team would find out early if one of them is real.

### Constraints

- The app must work fully offline on phone and laptop; sync is a convenience, never a requirement.
- Two developers; the first paying customers are expected in six months.
- Notes are text with attachments up to 10 MB; users expect edits on two devices at once not to lose text.
- The team wants to start with no server and add a hosted sync service later without migrating users' data by hand.

### Success criteria

- A recommended on-device storage choice and a sync strategy, with the alternatives rejected and why.
- How concurrent edits on two devices are reconciled, and what the user sees when they conflict.
- A migration path from no server to a hosted service that existing users do not notice.
- The main risks of the recommendation and how to find out early whether they bite.

## Swarm answer

_Run `01a1c39c-5d4e-727c-b377-4ada4aa2383b`, 12 rounds, completed/budget_rounds, $0.0000, confidence 0.85._

**Recommended Architecture: Local-First with Yjs and SQLite Metadata**  The app should adopt **Yjs** as the core CRDT engine for text synchronization, storing its serialized state in a lightweight format (JSON for small notes, chunked snapshots for large notes) within **SQLite**. **Attachments (>1MB)** must be stored as **external files on the filesystem**, linked to notes by UUID. This hybrid approach avoids Out-Of-Memory (OOM) risks associated with large BLOBs in SQLite while leveraging Yjs's robust conflict resolution. The 'sync metadata' table in SQLite should store persistent UUIDs and version vectors for each note, decoupling local state from server-specific identifiers to enable a seamless zero-migration sync path.

 **Reconciliation Strategy: Automated Merging with UI Fallback**  For concurrent edits, rely entirely on **Yjs's deterministic CRDT merging** to automatically merge text changes, ensuring no data is lost. Conflicts requiring user intervention should be minimal and limited to structural changes (e.g., adding/removing attachments) or severe corruption. In these rare cases, a '**Resolution Center**' UI should present divergent versions side-by-side, allowing the user to manually pick the winner. This approach balances automated safety with explicit user control where CRDTs cannot determine semantic intent.

 **Migration Path: UUID-First Policy**  To ensure zero-migration overhead when introducing a hosted sync service, enforce a strict '**UUID-first**' policy: every note and attachment must have a stable, globally unique ID stored in the SQLite metadata table. The future server will be designed to import local databases by reading these UUIDs and version vectors, treating existing local data as the source of truth. This allows the server to index notes without parsing the opaque CRDT state, enabling a smooth transition from local-only to sync-enabled operation.

 **Key Risks and Early Validation**  The main risk is the complexity of implementing Yjs client-side on mobile platforms and debugging CRDT state divergence during network partitions. To validate early, the team should build a '**dual-device editor**' prototype that simulates simultaneous edits offline with network dropouts. This stress test will measure merge latency, text integrity, and attachment consistency, allowing for an early pivot if performance degrades on low-end devices. Additionally, ensure atomicity of writes by committing text metadata within SQLite transactions while relying on OS-level file system integrity for external blobs.

## Baseline answer

_qwen3.6:35b-mlx, 4096 output tokens allowed under a $0.0000 cap, cost $0.0000._

# Recommendation: CRDT-based Replicated Local Storage with Conflict-Aware Sync Interface and Serverless-to-Hosted Bridge ## 1. On-Device Storage and Sync Strategy ### Recommended Approach: **Yjs (or similar text-based CRDT) + IndexedDB/Filesystem + Encrypted Blob Storage** For on-device storage, use a Content-Addressable or Object-Graph Local Database like **IndexedDB** (Web) or **SQLite** (Mobile) backed by a **Conflict-Free Replicated Data Type (CRDT)** library such as **Yjs**. Yjs is specifically designed for collaborative text editing and handles the 

## Judgements

Swarm 81.9%, baseline 16.7%, winner swarm.

### Order 1: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 3 — Recommends SQLite with external files for attachments, explicitly rejecting in-memory or BLOB storage to address the 10MB constraint and offline reliability on mobile devices. | 1 — Provides a recommendation but cuts off mid-sentence before providing the reasoning for the choice or rejecting alternatives. |
| conflicts | 3 | 2 — Describes automated merging via Yjs CRDTs and a 'Resolution Center' UI for structural conflicts, but fails to detail user-visible behavior for text merge failures or offline scenarios beyond weeks as required by the top scale. | 0 — The text is incomplete and does not explain how edits are merged or what the user sees. |
| migration | 3 | 3 — Proposes a specific 'UUID-first' policy stored in SQLite metadata that decouples local state from server identifiers, ensuring data is ready for import without re-importing when a server is added. | 0 — The text is incomplete and does not address the migration path from no server to hosted service. |
| correctness | 2 | 2 — The technical approach of using Yjs with SQLite and external files is sound and standard for this domain, though it oversimplifies the complexity of managing version vectors manually. | 0 — The response is truncated and contains no verifiable technical claims due to incompleteness. |
| risks | 2 | 3 — Identifies mobile performance/complexity risks and proposes a specific 'dual-device editor' prototype test with clear success metrics (latency, integrity), plus a fallback pivot mention. | 0 — The response is truncated and does not name any risks or detection methods. |

> Answer A is better because Answer B is truncated and fails to provide the majority of required information.

### Order 2: A = baseline, B = swarm; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 3 — Answer B recommends SQLite with Yjs and explicitly rejects large in-database BLOBs due to OOM risks, directly addressing the attachment size constraint. | 2 — Answer A recommends IndexedDB/SQLite with Yjs but truncates the explanation before providing the specific reasoning tied to the app's constraints, failing to achieve a score of 3. |
| conflicts | 3 | 2 — It describes automated merging via CRDTs but fails to specify the user-visible behavior for text conflicts (e.g., 'side-by-side diff') or how deletes are handled, limiting it to a score of 2. | 1 — The answer is incomplete and does not explain how concurrent edits are merged or what the user sees in case of conflict. |
| migration | 3 | 2 — It provides a concrete path using UUID-first storage in SQLite metadata, though it lacks the detail on what specific decisions must be made now to keep that path open for a score of 3. | 1 — The answer cuts off before describing any migration path from serverless to hosted. |
| correctness | 2 | 3 — The technical claims regarding Yjs, SQLite, and external file storage are sound and fit together logically for the stated constraints. | 0 — The text is truncated and incomplete, making it impossible to evaluate the technical claims or correctness. |
| risks | 2 | 2 — It names risks (complexity, divergence) and an early test (dual-device prototype), but fails to describe the fallback if that signal fires, limiting it to a score of 2. | 0 — The answer is truncated and does not name any risks or early tests. |

> Answer A is truncated/incomplete. Answer B is a complete response that addresses all rubric criteria, though with some minor shortcomings in detail compared to a perfect 3. Therefore, B is better overall.
