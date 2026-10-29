# Arturo language server

The server combines runtime observations with a tolerant structural view of source. It does not infer execution from block nesting, assign static scopes, or treat builtin names as reserved words. See Arturo's [language reference](https://arturo-lang.io/latest/documentation/language), [parser](https://github.com/arturo-lang/arturo/blob/master/src/vm/parse.nim), and [reflection reference](https://arturo-lang.io/documentation/library/reflection/).

## Development and verification

Use Bun 1.3.12 and Node 20 or newer:

```sh
bun install --frozen-lockfile
bun run compile
bun run lint
bun run test
```

Tests exercise the structural model, real Arturo execution, and a bare JSON-RPC client talking to the compiled server over stdio. Runtime tests require Arturo 0.10.0 on PATH (or `ARTURO=/absolute/path`); they explicitly skip when it is unavailable. Structural and untrusted-client tests still run. CI runs those portable tests; run the full suite with Arturo locally before changing the harness. VS Code integration can be checked by launching the extension host with F5, opening each Arturo language variant, configuring an entrypoint, refreshing, editing, and cancelling a long-running refresh.

`resources/builtins.json` is an offline metadata catalog generated from Arturo 0.10.0's reflection API. To regenerate it after validating a runtime change, run `bun run catalog`. This executes only the bundled harness against an empty block, never a workspace entrypoint. The catalog records its runtime version; hover and completion show only language documentation. The current adapter deliberately accepts only Arturo 0.10.0; other versions fail visibly until compatibility is tested.

The extension requires VS Code 1.82.0 because that is the minimum supported by Microsoft's `vscode-languageclient` 9.0.1. The language client, server, text-document, and URI dependencies are official Microsoft packages.

## Other editors

Run the compiled server with a Node runtime:

```sh
node /path/to/vscode-extension/out/server/main.js --stdio
```

Keep the `resources` directory alongside `out`. The server reads the bundled runtime template and builtin catalog relative to its installation, not its working directory. Production dependencies in `node_modules` must also be available. There is no dependency on VS Code in the server modules.

Use standard initialization, incremental document synchronization, completion, hover, definition, document symbols, folding ranges, and published diagnostics. Positions use UTF-16 code units. Source features do not require Arturo or workspace trust. Definition results from source are candidate locations, including labels that occur in data; they are not proof of runtime binding.

Runtime execution additionally requires the client to send `initializationOptions: { "runtimeTrusted": true }` after establishing workspace trust. The default is false. A client can update this using the `arturo/workspaceTrust` notification with `{ "trusted": true | false }`. Revoking trust cancels active refreshes and invalidates observations. This is a client authorization convention, not a process sandbox.

Each local workspace folder has independent settings and observations. The server requests `workspace/configuration` with that folder's URI and the section `arturo.runtime`. Return:

```json
{
  "executable": "arturo",
  "entrypoint": "main.art",
  "args": [],
  "cwd": "",
  "timeoutMs": 30000
}
```

Paths for `entrypoint` and `cwd` resolve relative to the workspace folder, independently. An empty `cwd` uses that folder. An entrypoint is mandatory. Timeout values must be integers from 100 to 3600000 milliseconds. Arguments are passed as an array without a shell. Clients without `workspace/configuration` can send equivalent nested `arturo.runtime` settings through `workspace/didChangeConfiguration`.

Send standard `workspace/executeCommand` requests with command `arturo.runtime.refresh` or `arturo.runtime.cancel`. The first argument is the workspace folder URI; it can be omitted for a single-folder workspace. Commands return the current runtime status. Refresh performs real project execution, including normal side effects, only in response to that explicit request. Other protocol requests never execute project code.

Subscribe to the custom `arturo/runtimeStatus` notification. Its fields are `workspaceUri`, `generation`, `state`, and optional `timestamp`, `entrypoint`, `staleReason`, and `message`. States are `idle`, `running`, `ready`, `stale`, `failed`, and `cancelled`. Generation numbers are monotonic per folder; cancellation also advances them. Timestamps identify the last successful observation. Runtime/program output is delivered through standard `window/logMessage` notifications, separately from protocol framing. These messages may contain the entrypoint's own output.

Hover and completion documentation show signatures, kinds, descriptions, attributes, and returns without runtime provenance or freshness warnings. Completion details show the binding kind; source-only labels infer direct literal types and show `:unknown` for unresolved expressions or conflicting assignments. Value hovers use compact signatures such as `greeting :string`. Clients should display runtime freshness separately, as VS Code does in its runtime status bar and tooltip. Stale snapshots remain available for hover and completion until replaced by a successful refresh.

Source functions declared with `$[parameters][body]` or `function [parameters][body]` expose their parameter names and type constraints in hover and completion. For example, `double: $[x :integer][x * 2]` shows `double x :integer` and `Returns: Integer` without executing the function. Untyped parameters accept `:any`. Return inference covers simple literals, parameter references, arithmetic (`+`, `-`, `*`, `add`, `sub`, `mul`), and simple explicit `return` expressions. Complex bodies and control flow show `Returns: Unknown`. Labels assigned calls to these source functions inherit a single known return type: `x: double 5` shows `x :integer`. Nested calls and chains of assigned labels are supported; missing or incompatible arguments, ambiguous returns, and cyclic assignments remain `:unknown`.

Function signatures use Arturo code blocks to preserve alignment, following the [official library reference](https://arturo-lang.io/documentation/library/core/function/): the first argument follows the function name, subsequent arguments align below it, and accepted types appear as lowercase colon-prefixed names (for example, `:literal :block`). Attribute types and returns retain their readable names (for example, `.import (Block)` and `Returns: Function`).

## Observations and limits

Each refresh starts a fresh Arturo process. The adapter records runtime version, configuration identity, workspace revision, generation, entrypoint, and completion time. The harness captures reflection helpers under randomized names before loading the entrypoint with `do`. Snapshot export retains binding names, observed kinds, available function arguments, attributes, returns, documentation, and source metadata. Values, memory addresses, and harness bindings are excluded from published observations. Arbitrary values are not recursively inspected and custom value printers are not called.

The harness context differs from direct CLI execution: `standalone?` is false and `script` exposes harness metadata. The entrypoint's path controls relative loading while the configured `cwd` controls the process working directory. Script arguments are forwarded. Global reflection observes the completed environment; it cannot establish bindings at arbitrary source positions, execution paths that were not taken, or locals in uncalled functions. Builtin rebinding is supported. Code that deliberately changes randomized harness bindings or breaks reflection can prevent capture and will fail rather than produce guessed results.

Stdin is closed. Interactive programs and live inspection of servers or other long-running applications are outside v1. The refresh timeout defaults to 30 seconds. Output and metadata are each capped at 10 MiB. Cancellation and timeout terminate the execution process group on Unix and use `taskkill /T /F` on Windows. This is cleanup of ordinary child processes, not containment of programs that deliberately detach or escape the process group.

Only a successful completed run with valid metadata replaces an observation. Errors, early exits, invalid metadata, output limits, and cancellation preserve any previous observation as stale. Edits, opening documents, saves, configuration changes, and watched file events invalidate freshness; events during execution leave the resulting snapshot stale. Unsaved buffer text is compared with disk before execution and never silently saved or executed by the server. A successful snapshot made while buffers differ remains stale.

Clients must send file-change and configuration notifications to maintain freshness. VS Code forwards workspace filesystem events using a watcher; excluded/unwatched paths and dependencies outside the workspace are not tracked. External resources, time, environment changes, and files accessed dynamically cannot be comprehensively tracked. “Ready” describes a completed observed workspace revision, not reproducibility or semantic certainty.

Structural diagnostics cover verified delimiter and string errors only. Runtime diagnostics are a separate source and are attached only to open, unchanged, saved text with a verifiable file/line from an explicit failed run. Other errors remain in the output log. Snapshot failures do not create invented source positions. Existing terminal Run commands remain independent of snapshot execution and do not collect diagnostics.

Rename, reference search, signature help, formatting, type diagnostics, semantic call graphs, live frame inspection, and exact cross-file resolution are deferred.
