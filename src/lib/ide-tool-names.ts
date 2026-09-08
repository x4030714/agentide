/** The `ide_*` tools the host answers. Must match what the sidecar declares to the
 * model, or the model sees a broken tool — a test diffs the two. Keep it import-free. */
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
