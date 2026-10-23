# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This file was accidentally overwritten during development and rebuilt from the
> change log of the work that produced 0.1.0. Entries below summarise real
> changes; the original wording is lost.

## [0.1.0] - 2026-10-23

### Added

- DSH host plugin (`dsh-stm32-toolchain`) that spawns `lib/bridge.mjs` as an MCP
  stdio server and proxies its loopback HTTP/SSE surface to the browser half.
- 14 agent tools: doctor, status, project, build, flash, deploy, checkout, claim,
  serial, logs, chips, ports, open_vscode, cube_gen.
- Headless Keil build (`UV4 -b`) with structured diagnostics; ST-Link download
  (`UV4 -f`); AN3155 system-bootloader flasher over any serial pipe.
- Main-page panel: two rows of stat cards, action bar, live SSE log stream with
  channel tabs, diagnostic list, project picker, serial send box.
- Settings card with four categories (常规 / 工具链 / 日志文字 / 日志颜色), hairline
  rows, official `Switch` and `Menu` primitives, and a single-column 1-8 drag
  list for card order.
- Log text options (size, line height, row cap, wrap, timestamps), per-channel
  colours, an optional background gradient and a live preview.
- Board lease: owner label, TTL 180 s, 15 s heartbeat while a job runs, forced
  release, cross-process `.lock.json`; `/state` reports the holder and age.
- Session binding: a control in `conversation.session.header.actions` (the same
  spot as 打开 MATLAB) with three states - unbound / bound to this session /
  bound elsewhere - persisted in `.state.json`; the panel sends prompts through
  the host `POST /ask` route.
- Tests: runtime, settings, client, client-primitives, jump, vscode, lease,
  presentation, paths, no-project, smoke, bridge.

### Changed

- Settings apply immediately where possible: presentation goes through a
  client-side store, toolchain paths are pushed with `set-tools`, scan roots are
  sent with each scan. Only 启用插件 / 注入工作规范 / 桥接端口 / 单次工具超时 need a
  host reload and say so in the UI.
- The folder picker uses the app's native picker, falling back to a Vista+
  `IFileOpenDialog` and only then to `FolderBrowserDialog`.
- 扫描工程 looks at the current project's parent plus Desktop/Documents/Downloads,
  optionally extended by `searchRoots`, and reports its scope.
- 清空日志 became a menu: 清空当前日志 (selected tab, and everything on 全部) and
  清空所有日志.
- `transport: swd | uart`; ESP fields reserved for the 0.2.0 Wi-Fi transport.

### Fixed

- Settings never applied: DSH hands `volatile` config fields over as live
  references, so every value fell back to its default. `apply()` unwraps them.
- A stale presentation overlay shadowed the saved value; removed - the host
  config is authoritative and the client store applies it on save.
- Saves erased values the form no longer held (describe omits default-equal
  keys); `buildOps`/`mergeForm` only write what the form owns.
- A refused action (no project) left the board claimed; project validation now
  runs before the lease and an implicit lease is released when its job fails.
- 释放 looked broken (no state push, and the panel merged action results).
- A second panel action was refused as BOARD_BUSY; token-less callers share one
  implicit lease.
- Stale log rows with duplicate keys after a bridge restart; entries are tagged
  with a per-process instance and a new instance resets the stream.
- Chinese paths arrived mangled from the PowerShell dialog (`D:\ʵ���Ҿ���`), so
  scanning found nothing: the path now crosses as a UTF-8 file and `repairPath`
  recovers latin1-mangled input.
- Opening a diagnostic emptied the file: build logs carry relative paths and
  `code -g` resolved them against VS Code's cwd. Paths resolve against the project
  and a missing file is refused. The VSCode button opens the project **root**,
  climbing out of MDK-ARM/Objects.
- 交给 AI crashed with `Cannot destructure property 'source' of 'options'`; session
  creation is gone in favour of binding.

### Known limitations

- Wi-Fi transport (ESP-01S firmware + TCP byte pipe) is not implemented yet.
- Wireless SWD debugging needs an ESP32-S3 running CMSIS-DAP over TCP.
- Page-level erase, option bytes and read-out protection are not exposed.
