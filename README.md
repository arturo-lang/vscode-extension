<h1 align="center">
    Arturo for VS Code
</h1>

<p align="center">
<i>First-class editing, running, and package management support directly inside your favorite text editor.</i>
<br>
<br><br>
<img 
    alt="Arturo logo" 
    width="20" 
    src="https://github.com/arturo-lang/arturo/raw/master/docs/images/logo.png#gh-light-mode-only"
/>
<img 
    alt="Arturo logo" 
    width="20" 
    src="https://github.com/arturo-lang/arturo/raw/master/docs/images/logo-lightgray.png#gh-dark-mode-only" 
/>
<br>
<b>~ CODE IS ART ~</b>
</p>

<p align="center">
    <img alt="GitHub License" src="https://img.shields.io/github/license/arturo-lang/vscode-extension?style=flat-square"> <img alt="Visual Studio Marketplace Downloads" src="https://img.shields.io/visual-studio-marketplace/d/drkameleon.arturo?style=flat-square&label=Downloads%20on%20VS%20Code&labelColor=blue&color=black&cacheSeconds=30&link=https%3A%2F%2Fmarketplace.visualstudio.com%2Fitems%3FitemName%3Ddrkameleon.arturo">
</p>

## Requirements
- VS Code 1.82.0 or newer
- Arturo 0.10.0 for runtime snapshots; Arturo on PATH for running, bundling, REPL, and package commands. Source editing features work without Arturo installed.

See how to install Arturo on our [official website](https://arturo-lang.io/).

## Highlights
- Syntax highlighting for Arturo files.
- Distinct file icons (gray for code, purple for tests/config) supporting both light and dark themes.
- Ready-to-use snippets for core language constructs (arithmetic, collections, logic, IO, numbers, strings, types, and more)
- Runtime-assisted completion and hover, with explicit snapshot refresh and visible freshness.
- Structural diagnostics, folding, label outlines, and candidate definition navigation.
- One-click run of the active file in a terminal.
- Built-in REPL launcher and bundler workflow.
- Integrated package manager commands (install, uninstall, list, remote, update all).
- Quick links to documentation and a prefilled issue reporter.

### Commands
You can find these in the Command Palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>) under "Arturo:". The run-current command also appears in the editor title bar for Arturo files.

| Command | Purpose |
| --- | --- |
| Arturo: Open REPL | Launch an Arturo REPL in a new terminal |
| Arturo: Run File | Choose any `.art` file in the workspace and run it in a terminal |
| Arturo: Run Current File | Save and run the active Arturo file in a terminal |
| Arturo: Refresh Runtime Snapshot | Execute the configured entrypoint and observe its completed global environment |
| Arturo: Cancel Runtime Refresh | Stop the selected workspace's active refresh |
| Arturo: Bundle File | Pick a script and produce a bundled executable (optional custom output name) |
| Arturo: Manage Packages | Install, Uninstall, Update and Open Documentation of Packages |
| Arturo: Open Documentation | Open the Arturo's Documentation on side-view |
| Arturo: Report Issue | Open GitHub issues with system details prefilled |

### Grammar
- Applies syntax highlight to any Arturo file.
- This also supports language config to enhance our editor integration, such as quick comment code or auto-closing pair characters...

### Reporting Issues and Reading the Docs

- `Arturo: Open Documentation` opens the latest library docs beside your editor.
- `Arturo: Report Issue` opens the GitHub issue form with OS, Arturo, VS Code, and extension versions prefilled to speed up triage.

## Installation
- From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=drkameleon.arturo).
- From source: clone the repo, run `bun install`, then `bun run compile`. Launch the extension host with <kbd>F5</kbd>. See [docs/Setup.md](docs/Setup.md) for full contributor setup.

## Runtime language intelligence

Configure a saved entrypoint in your workspace settings:

```json
{
  "arturo.runtime.entrypoint": "main.art",
  "arturo.runtime.executable": "arturo",
  "arturo.runtime.args": [],
  "arturo.runtime.cwd": "",
  "arturo.runtime.timeoutMs": 30000
}
```

Entrypoint and working-directory paths resolve relative to the workspace folder. In a multi-folder workspace, each folder has its own configuration and snapshot. Trust the workspace and run **Arturo: Refresh Runtime Snapshot** to execute that entrypoint in a fresh process. Execution can perform the script's normal side effects. Editing, saving, hover, and completion never execute it. Unsaved edits are not executed; the runtime status bar shows stale when buffers differ from saved files or workspace files change. Its tooltip contains execution details and the freshness reason.

Completion and hover show concise signatures, kinds, descriptions, attributes, and returns using runtime metadata or the bundled builtin catalog. Value bindings show compact signatures such as `greeting :string`. Source-only labels infer direct literal types; expressions and conflicting assignments show `:unknown` until runtime metadata is available. Execution details and freshness warnings stay in the status bar rather than the documentation popup. Runtime globals describe the end of the last successful run, not necessarily the binding at your cursor. Labels inside blocks can be data, and unknown words are not reported as static errors. Optional runtime parameter constraints appear as metadata; the server does not statically type-check Arturo.

Source functions declared with `$[parameters][body]` or `function [parameters][body]` expose their parameter names and type constraints in hover and completion. For example, `double: $[x :integer][x * 2]` shows `double x :integer` and `Returns: Integer` without executing the function. Untyped parameters accept `:any`. Return inference covers simple literals, parameter references, arithmetic (`+`, `-`, `*`, `add`, `sub`, `mul`), and simple explicit `return` expressions. Complex bodies and control flow show `Returns: Unknown`.

Signatures follow the [official library reference](https://arturo-lang.io/documentation/library/core/alias/): lowercase colon-prefixed types such as `:literal :block`, with each argument on its own aligned line.

The harness loads your entrypoint with `do`: arguments and relative loads work, but `standalone?` is false and `script` exposes harness metadata. It observes completed globals, without invoking uncalled functions or custom value printers. Long-running and interactive applications are outside this first release. No snapshot is published after an error, early exit, timeout, or cancellation; an older observation remains visibly stale. Runtime failures are shown in **Arturo Language Server** output, with inline diagnostics only where saved-source locations can be verified. The existing terminal Run commands do not collect diagnostics.

See [the language server guide](docs/LanguageServer.md) for other editors, protocol details, compatibility limits, and testing.

## Contributing

PRs and Issues are welcome. 
Please check [docs/Contributing.md](docs/Contributing.md) before submitting changes.
