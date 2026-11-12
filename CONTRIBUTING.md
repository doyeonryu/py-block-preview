# Contributing

Thanks for helping improve Python Block Preview! Issues and pull requests are welcome in English or Korean.

## Development setup

Requirements: Node.js 20+ and VS Code 1.90+.

```sh
npm install
npm test          # build + analyzer and webview tests
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with `test/fixtures/sample.py` open, then press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> (**Python: Block Preview**). Run `npm run watch` in a terminal to rebuild on save, and reload the development window (<kbd>Ctrl</kbd>+<kbd>R</kbd>) to pick up changes.

Other scripts:

| Script | What it does |
|---|---|
| `npm run inspect -- path/to/file.py` | Print what the analyzer extracts from a file (add `--json` for the raw model) |
| `npm run typecheck` | Type-check everything with `tsc` |
| `npm run package` | Build a production `.vsix` |
| `npm run install-ext` | Package and install into your local VS Code (`EDITOR_CLI=cursor npm run install-ext` for Cursor) |

## How it works

```
VS Code editor ──text──▶ PreviewPanel ──source──▶ PythonParser ──▶ analyze() ──ModuleModel──▶ webview
      ▲                    (src/previewPanel.ts)   (tree-sitter)    (src/parser)               (webview/)
      └──────────── reveal(line) ◀──── click ──────────────────────────────────────────────────────┘
```

| Path | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, panel restore |
| `src/previewPanel.ts` | The webview panel: follows the active editor, debounces edits, relays cursor and click messages |
| `src/parser/pythonParser.ts` | Loads tree-sitter (WASM). If the file has syntax errors, re-parses each top-level `def`/`class` separately so errors stay local |
| `src/parser/plainTree.ts` | Converts the tree-sitter tree into plain JS objects in one pass (node access across the WASM boundary is slow) |
| `src/parser/analyze.ts` | Builds the model: definitions, signatures, calls and their targets, control flow, variables |
| `src/model/ir.ts` | The JSON model and the message protocol shared by the extension and the webview |
| `webview/canvas.ts` | Canvas view: block HTML, column layout by call depth, call arrows, pan/zoom |
| `webview/main.ts` | Webview entry: state, list view, cursor sync, events |
| `webview/style.css` | Styles, built on VS Code theme variables so light and dark themes both work |

The analyzer has no dependency on the `vscode` module, so it can be tested and run from plain Node (`npm run inspect`).

## Tests

- `test/analyzer.test.ts` — model extraction against `test/fixtures/*.py`.
- `test/webview.test.ts` — runs the bundled webview in jsdom: rendering, layout order, cursor sync, clicks, filtering, HTML escaping. jsdom has no layout engine, so check visual changes in the development host as well.

When you fix an analyzer bug, add a small fixture or a case to `analyzer.test.ts` that reproduces it.

## Pull requests

1. Fork and create a branch from `main`.
2. Keep changes focused; run `npm run typecheck` and `npm test`.
3. Add an entry under **Unreleased** in `CHANGELOG.md` for user-visible changes.
4. For UI changes, include a screenshot in the PR description.

## Releasing (maintainers)

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading.
2. `npm version <patch|minor|major>` — updates `package.json` and creates a `v*` tag.
3. `git push --follow-tags` — the **Release** workflow builds, tests, packages the `.vsix`, and attaches it to a GitHub release.
