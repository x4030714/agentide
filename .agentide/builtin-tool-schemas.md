# Built-in tool schemas, as the model receives them

Extracted from `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` (SDK 0.3.259,
CLI manifest 2.1.259). Generated from the CLI's own JSON Schema, so these are the
real parameter descriptions, verbatim.

**What this is not:** the top-level "use this tool when…" prose for each tool is not
here. That lives with the tool definition inside the compiled CLI binary, not in the
input schema. So this shows *how* each tool is driven, not the pitch that competes
for the model's attention.

**Why it is the right reference anyway:** it is the register your `ide_*` descriptions
have to match — imperative, specific about when a parameter does and does not apply,
and explicit about failure. Notice how often a description spends its words on a
constraint rather than a definition.

## Grep

*The one ide_references has to beat.*

- **`pattern`** — `string`
  The regular expression pattern to search for in file contents
- **`path`** *(optional)* — `string`
  File or directory to search in (rg PATH). Defaults to current working directory.
- **`glob`** *(optional)* — `string`
  Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob
- **`output_mode`** *(optional)* — `"content" | "files_with_matches" | "count"`
  Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".
- **`"-B"`** *(optional)* — `number`
  Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.
- **`"-A"`** *(optional)* — `number`
  Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.
- **`"-C"`** *(optional)* — `number`
  Alias for context.
- **`context`** *(optional)* — `number`
  Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.
- **`"-n"`** *(optional)* — `boolean`
  Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.
- **`"-i"`** *(optional)* — `boolean`
  Case insensitive search (rg -i)
- **`"-o"`** *(optional)* — `boolean`
  Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.
- **`type`** *(optional)* — `string`
  File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.
- **`head_limit`** *(optional)* — `number`
  Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).
- **`offset`** *(optional)* — `number`
  Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.
- **`multiline`** *(optional)* — `boolean`
  Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.

## Glob

*Name-pattern search; ide_workspace_symbols is the semantic answer.*

- **`pattern`** — `string`
  The glob pattern to match files against
- **`path`** *(optional)* — `string`
  The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.

## Read

*ide_document_symbols is the cheap alternative for 'what is in this file'.*

- **`file_path`** — `string`
  The absolute path to the file to read
- **`offset`** *(optional)* — `number`
  The line number to start reading from. Only provide if the file is too large to read at once
- **`limit`** *(optional)* — `number`
  The number of lines to read. Only provide if the file is too large to read at once.
- **`pages`** *(optional)* — `string`
  Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.

## Edit

*What ide_rename_symbol must route through the diff queue instead of.*

- **`file_path`** — `string`
  The absolute path to the file to modify
- **`old_string`** — `string`
  The text to replace
- **`new_string`** — `string`
  The text to replace it with (must be different from old_string)
- **`replace_all`** *(optional)* — `boolean`
  Replace all occurrences of old_string (default false)

## Bash

*ide_run_in_terminal makes this visible rather than replacing it.*

- **`command`** — `string`
  The command to execute
- **`timeout`** *(optional)* — `number`
  Optional timeout in milliseconds (max 600000)
- **`description`** *(optional)* — `string`
  Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.  For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words): - ls → "List files in current directory" - git status → "Show working tree status" - npm install → "Install package dependencies"  For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does: - find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively" - git reset --hard origin/main → "Discard all local changes and match remote main" - curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"
- **`run_in_background`** *(optional)* — `boolean`
  Set to true to run this command in the background.
- **`dangerouslyDisableSandbox`** *(optional)* — `boolean`
  Set this to true to dangerously override sandbox mode and run commands without sandboxing.
