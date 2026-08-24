# Version-matched stdio client

`t3 client --stdio` exposes a small, normalized NDJSON client protocol for non-web renderers such as Emacs. It keeps Effect RPC framing, HTTP authentication, WebSocket tickets, T3 contracts, and shell reducers inside the same versioned bundle as the server.

The bridge reads the environment endpoint from the protocol `hello` record. Authentication is supplied through one of these process environment variables:

- `T3_CLIENT_PAIRING_TOKEN`: a fresh one-time pairing credential. The bridge exchanges it for an `orchestration:read` + `orchestration:operate` bearer session.
- `T3_CLIENT_ACCESS_TOKEN`: an existing bearer session token.

The bridge clears the selected variable from its own environment after reading it. Credentials and WebSocket tickets are never written to protocol stdout. Pairing tokens can be created with `t3 auth pairing create`.

The initial capability surface is intentionally narrow:

- `server.getConfig`
- authoritative HTTP shell snapshots
- resumed `orchestration.subscribeShell` WebSocket updates
- normalized replacement shell projections, including settled-thread classification through the shared settlement logic and parent/subagent lineage for hierarchical renderers; provider-native compatibility rows without an app-thread projection are omitted
- bounded HTTP thread snapshots followed by resumed `orchestration.subscribeThread` updates, reduced inside the bridge and exposed as normalized timeline replacements; provider-derived IDs rejected by path routers fall back to a one-shot RPC snapshot that is immediately normalized and resumed
- normalized message dispatch, interrupt, approval, mode, settlement, and snooze operations with stable semantic command IDs

Bridge output uses a bridge-local contiguous sequence. Server event sequences are intentionally not exposed because the orchestration event log can contain gaps from events irrelevant to the shell projection. On reconnection, the bridge always loads an authoritative HTTP snapshot and treats the client's `resumeSequence` only as the starting point for its outgoing sequence.

Pull-request state is not yet loaded by this narrow shell bridge, so PR-based settle/block rules are deferred until the PR projection is added. Pending runtime work and active runs still block settlement through the shared classifier.

Thread payloads retain the 100 most recent visible items with a 256,000-byte aggregate text budget and 32,000-character per-field cap. Display fields are normalized to bounded single lines, final payloads target at most 700,000 encoded bytes, and every output record has a hard 900,000-byte ceiling below the client's 1 MiB frame limit. Shell snapshots are likewise count- and byte-bounded and set `truncated: true` whenever projects or threads are omitted. Arbitrary dynamic-tool input/output is deliberately omitted because provider-controlled values may contain credentials. Stream failures and unexpected normal completion retry after a delay with a fresh authoritative snapshot until unsubscribe interrupts the supervised fiber. Unsupported operations and streams return structured protocol errors. Request failures stay request-scoped rather than terminating the bridge. Terminal streams, SSH launch, relay/DPoP authorization, and credential persistence are separate milestones.
