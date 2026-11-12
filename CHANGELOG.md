# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
