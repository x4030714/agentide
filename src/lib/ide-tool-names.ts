/**
 * The `ide_*` tools the host answers.
 *
 * This list exists apart from the code that implements it for one reason: it has to agree
 * with the tools the sidecar declares to the model, and the two live in different
 * processes. A name declared there and missing here is not a compile error -- the Rust
 * core answers "not available in this build" and the model sees a permanently broken
 * tool. `ide-tool-names.test.ts` reads the sidecar's source and fails if they drift.
 *
 * Kept free of imports so that test can load it without pulling in Monaco.
 */
export const HOST_TOOL_NAMES = [
  "ide_open",
  "ide_selection",
  "ide_open_editors",
  "ide_diagnostics",
  "ide_definition",
  "ide_references",
  "ide_document_symbols",
  "ide_workspace_symbols",
  "ide_rename_symbol",
  "ide_run",
  "ide_hover",
  "ide_implementations",
  "ide_code_actions",
  "ide_terminal_read",
  "ide_terminal_stop",
] as const;
