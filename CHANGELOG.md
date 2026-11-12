# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-11-12

### Changed
- New shortcut: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> on macOS) instead of <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>B</kbd>. The same shortcut or the editor title button closes the preview again.
- The editor title button is named **Block Preview**, and its tooltip shows the shortcut.
- The preview no longer reopens by itself after a window reload.
- All UI text is in English.

## [0.1.1] - 2026-11-12

### Fixed
- Works in WSL, SSH and Dev Container windows without installing the extension on the remote side: it now runs on the local machine (`extensionKind: ["ui", "workspace"]`).

## [0.1.0] - 2026-11-12

### Added
- Live preview panel that follows the active Python editor (`Ctrl+K B` or the editor title button).
- Canvas view: functions as block stacks, C-shaped control-flow blocks, call arrows, pan and zoom, fit to screen, columns ordered by call depth.
- Summary mode, chosen automatically for large files.
- Inspector panel with calls, callers, returns, raised exceptions, locals and globals.
- List view with collapsible cards.
- Cursor ↔ block synchronisation and click-to-reveal.
- Call resolution within the file, including `self.method()` and simple type inference from constructors, annotations and return annotations.
- Error-tolerant parsing: syntax errors stay inside the definition that contains them.
