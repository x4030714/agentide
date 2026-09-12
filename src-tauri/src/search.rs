//! Literal full-text search across the open workspace.
//!
//! Text, not symbols: `ide_references` answers "who uses this name" properly and the agent is
//! told to prefer it. This is the other question -- a log message, a TODO, a config key, a
//! string that appears in three languages at once -- which no language server indexes.
//!
//! Literal only, no regex. Every search here runs as you type, and a pattern with a nested
//! quantifier turns a keystroke into a minute of walking; the box would have to grow a "stop"
//! button before it could safely grow a `.*`.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use ignore::WalkState;
use tauri::State;

use crate::fs::{looks_binary, workspace_walk, WorkspaceState, MAX_FILE_BYTES};
use crate::ipc::{ErrorCode, IpcError, SearchMatch, SearchOptions, SearchResults, WirePath};

/// Past this the list is not an answer, it is a haystack. Reported rather than trimmed
/// silently: `truncated` is what lets the pane say "narrow the query".
const MAX_MATCHES: usize = 2000;

/// How much of the line either side of a match travels to the frontend. The row is one line
/// of a fixed-width pane, so more than this is measured, laid out and then clipped by CSS.
const CONTEXT_CHARS: usize = 120;

/// Search every file in the workspace for `query`.
///
/// The whole walk goes on a blocking thread: this reads every file in the tree, which on a
/// native codebase is seconds, and a tokio worker held that long stops answering the editor's
/// own reads. `git.rs` runs its commands inline because a git call is short; this is not.
#[tauri::command]
pub async fn search_workspace(
    workspace: State<'_, WorkspaceState>,
    query: String,
    options: SearchOptions,
) -> Result<SearchResults, IpcError> {
    let Some(root) = workspace.root() else {
        return Ok(empty());
    };
    // An empty query matches everything, which is the same as matching nothing and costs a
    // whole walk to say so.
    if query.is_empty() {
        return Ok(empty());
    }

    let dir = root.to_path();
    tauri::async_runtime::spawn_blocking(move || search_tree(&dir, &query, &options))
        .await
        .map_err(|err| {
            // `Io` for want of anything better: a background task that panicked or was
            // cancelled is not a failure the frontend can act on, and inventing an
            // `ErrorCode` the pane would never branch on is a wire change for nothing.
            IpcError::new(
                ErrorCode::Io,
                format!("the search thread did not finish: {err}"),
            )
        })
}

fn empty() -> SearchResults {
    SearchResults {
        matches: Vec::new(),
        files: 0,
        searched: 0,
        truncated: false,
    }
}

/// The search itself, against a directory rather than the app's state, which is what makes it
/// testable without standing up a Tauri app.
pub(crate) fn search_tree(root: &Path, query: &str, options: &SearchOptions) -> SearchResults {
    let found: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());
    let searched = AtomicU32::new(0);
    let truncated = AtomicBool::new(false);

    workspace_walk(root).build_parallel().run(|| {
        Box::new(|result| {
            if truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = result else {
                // A path that cannot be read is not a match and not an error worth a row.
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                return WalkState::Continue;
            };
            if meta.len() > MAX_FILE_BYTES {
                return WalkState::Continue;
            }
            let Ok(bytes) = fs::read(path) else {
                return WalkState::Continue;
            };
            // The same two gates `read_file` applies, for the same reason: a hit in a file the
            // editor will refuse to open is a result that goes nowhere when clicked.
            if looks_binary(&bytes) {
                return WalkState::Continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                return WalkState::Continue;
            };
            let Ok(wire) = WirePath::from_path(path) else {
                return WalkState::Continue;
            };
            searched.fetch_add(1, Ordering::Relaxed);

            // `read_file` hands the editor the text with the byte-order mark taken off, so it
            // comes off here too: counted in, every column on line 1 of such a file is one out.
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            let hits = search_text(text, &wire, query, options);
            if hits.is_empty() {
                return WalkState::Continue;
            }

            let mut all = found.lock().expect("search results poisoned");
            all.extend(hits);
            // One past the cap, not at it: a search with exactly `MAX_MATCHES` hits has been
            // answered in full, and stopping at the cap would report that complete answer as
            // "the first 2000 of more". The extra match costs one file's read and is dropped.
            if all.len() > MAX_MATCHES {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });

    let mut matches = found.into_inner().expect("search results poisoned");
    // Threads finish in whatever order the OS chose, so the same search would otherwise list
    // its files differently each time it ran.
    matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    let cut = truncated.load(Ordering::Relaxed);
    if cut {
        matches.truncate(MAX_MATCHES);
    }

    let mut files = 0u32;
    let mut last: Option<&WirePath> = None;
    for hit in &matches {
        if last != Some(&hit.path) {
            files += 1;
            last = Some(&hit.path);
        }
    }

    SearchResults {
        matches,
        files,
        searched: searched.load(Ordering::Relaxed),
        truncated: cut,
    }
}

/// Every match in one file's text.
fn search_text(
    text: &str,
    path: &WirePath,
    query: &str,
    options: &SearchOptions,
) -> Vec<SearchMatch> {
    let mut hits = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        // Split on `\n` and drop the `\r`, rather than splitting on both: a lone `\r` inside a
        // line is not a line break here, and treating it as one would number every later
        // match in the file wrongly.
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        for (start, end) in find_all(line, query, options) {
            hits.push(SearchMatch {
                path: path.clone(),
                line: index as u32 + 1,
                column: utf16_column(line, start),
                end_column: utf16_column(line, end),
                before: tail(&line[..start], CONTEXT_CHARS),
                matched: line[start..end].to_string(),
                after: head(&line[end..], CONTEXT_CHARS),
            });
        }
    }
    hits
}

/// Every occurrence of `needle` in `line`, as byte ranges, left to right and non-overlapping.
///
/// Two comparisons rather than one. An all-ASCII needle is matched byte-wise, which is exact:
/// `eq_ignore_ascii_case` compares bytes above ASCII for equality and no ASCII byte appears
/// inside a multi-byte character, so a window that matches is necessarily a whole-character
/// one. A needle carrying any non-ASCII character takes the slower path instead -- typing `ü`
/// and not finding `Ü` reads as the search being broken, not as a documented limit.
///
/// Every offset comes from `line` itself and never from a folded copy of it: folding can change
/// a string's length -- U+0130 lower-cases to two characters -- and an offset into the copy
/// would put the editor's cursor somewhere else.
fn find_all(line: &str, needle: &str, options: &SearchOptions) -> Vec<(usize, usize)> {
    if needle.is_empty() {
        return Vec::new();
    }
    // Folded once per line rather than once per position, and only on the path that needs it.
    let folded: Option<Vec<char>> = (!options.case_sensitive && !needle.is_ascii())
        .then(|| needle.chars().flat_map(char::to_lowercase).collect());

    let mut hits = Vec::new();
    let mut at = 0usize;
    while at < line.len() {
        if let Some(end) = match_at(line, at, needle, options, folded.as_deref()) {
            if !options.whole_word || is_whole_word(line.as_bytes(), at, end) {
                hits.push((at, end));
                at = end;
                continue;
            }
        }
        // On to the next character boundary, rather than past the whole candidate: a match
        // rejected for sitting inside a word can overlap one that does not, the way `a a`
        // does twice over in `xa a a`.
        at += 1;
        while at < line.len() && !line.is_char_boundary(at) {
            at += 1;
        }
    }
    hits
}

/// The byte offset just past a match beginning exactly at `at`, or `None` when there is none.
fn match_at(
    line: &str,
    at: usize,
    needle: &str,
    options: &SearchOptions,
    folded: Option<&[char]>,
) -> Option<usize> {
    if let Some(folded) = folded {
        return match_folded(line, at, folded);
    }
    let window = line.as_bytes().get(at..at + needle.len())?;
    let same = if options.case_sensitive {
        window == needle.as_bytes()
    } else {
        window.eq_ignore_ascii_case(needle.as_bytes())
    };
    same.then_some(at + needle.len())
}

/// The byte offset just past a case-folded match beginning exactly at `at`.
///
/// Character by character, because one character can fold to several -- U+0130 gives an `i` and
/// a combining dot -- so there is no fixed-width window to compare. A character whose folded
/// form runs past the end of the needle is not a match: the needle would cover part of one
/// character, which is not a range the editor could select.
fn match_folded(line: &str, at: usize, folded: &[char]) -> Option<usize> {
    let mut wanted = 0usize;
    for (offset, ch) in line[at..].char_indices() {
        if wanted == folded.len() {
            return Some(at + offset);
        }
        for lower in ch.to_lowercase() {
            if folded.get(wanted) != Some(&lower) {
                return None;
            }
            wanted += 1;
        }
    }
    // The needle ran out exactly at the end of the line.
    (wanted == folded.len()).then_some(line.len())
}

/// A match is a whole word when neither neighbouring byte could be part of the same identifier.
///
/// Any byte above ASCII counts as part of a word: in an identifier a non-ASCII byte is a letter
/// far more often than not, so `caf\u{e9}x` must not report a whole-word hit for `x`. The cost is
/// that whole-word means nothing in CJK text, where it is a meaningless question anyway.
fn is_whole_word(hay: &[u8], start: usize, end: usize) -> bool {
    let before = start.checked_sub(1).map(|at| hay[at]);
    let after = hay.get(end).copied();
    !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// A byte offset as Monaco counts columns: 1-based UTF-16 code units.
fn utf16_column(line: &str, at: usize) -> u32 {
    line[..at].encode_utf16().count() as u32 + 1
}

/// The end of `text`, at most `max` characters, with leading whitespace dropped. Clipped from
/// the left because what matters is what sits immediately before the match.
fn tail(text: &str, max: usize) -> String {
    let trimmed = text.trim_start();
    let count = trimmed.chars().count();
    if count <= max {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - max).collect()
}

/// The start of `text`, at most `max` characters.
fn head(text: &str, max: usize) -> String {
    text.trim_end().chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: SearchOptions = SearchOptions {
        case_sensitive: true,
        whole_word: false,
    };
    const FOLDED: SearchOptions = SearchOptions {
        case_sensitive: false,
        whole_word: false,
    };
    const WORDS: SearchOptions = SearchOptions {
        case_sensitive: false,
        whole_word: true,
    };

    /// A scratch directory that removes itself when the test ends. A copy of `fs.rs`'s rather
    /// than a shared one: test scaffolding reaching across modules is how a test starts
    /// depending on another module's test setup.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentide-search-{tag}-{unique}"));
            fs::create_dir_all(&dir).expect("cannot create scratch dir");
            Self(dir)
        }

        fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("cannot create scratch subdir");
            }
            fs::write(path, contents).expect("cannot write scratch file");
        }

        fn search(&self, query: &str, options: &SearchOptions) -> SearchResults {
            search_tree(&self.0, query, options)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn every_occurrence_on_a_line_is_reported() {
        let hits = find_all("a bat, a bar, a bag", "ba", &PLAIN);
        assert_eq!(hits, vec![(2, 4), (9, 11), (16, 18)]);
    }

    #[test]
    fn overlapping_occurrences_are_reported_once() {
        // `aaaa` holds three overlapping `aa`, and reporting all three would put two cursors
        // inside one word and count the file three times over.
        assert_eq!(find_all("aaaa", "aa", &PLAIN), vec![(0, 2), (2, 4)]);
    }

    #[test]
    fn a_column_is_counted_the_way_monaco_counts_it() {
        // The unit is the whole point: `\u{1d54f}` is one character, two UTF-16 code units and
        // four bytes, so a byte offset would place the cursor two columns early -- and the
        // failure looks like the editor scrolling to roughly the right place.
        let path = WirePath::parse("C:/w/a.rs").expect("path");
        let hits = search_text("let \u{1d54f} = needle;", &path, "needle", &PLAIN);
        assert_eq!(hits.len(), 1);
        // `let ` is 4 units, `\u{1d54f}` is 2, ` = ` is 3: nine before the match, and Monaco
        // counts from one. By bytes it would be 12, by characters 9.
        assert_eq!(hits[0].column, 10);
        assert_eq!(hits[0].end_column, 16);
        assert_eq!(hits[0].matched, "needle");
    }

    #[test]
    fn folding_case_does_not_move_the_match() {
        let hits = find_all("HashMap::new()", "hashmap", &FOLDED);
        assert_eq!(hits, vec![(0, 7)]);
        assert!(find_all("HashMap::new()", "hashmap", &PLAIN).is_empty());
    }

    #[test]
    fn folding_a_non_ascii_needle_still_lands_on_the_right_bytes() {
        // Four characters of needle spanning five bytes of line, because `\u{dc}` is two of
        // them. The byte-wise path cannot fold this at all, which is why there are two paths.
        let hits = find_all("der \u{dc}BERBAU", "\u{fc}ber", &FOLDED);
        assert_eq!(hits, vec![(4, 9)]);
        assert!(find_all("der \u{dc}BERBAU", "\u{fc}ber", &PLAIN).is_empty());
    }

    #[test]
    fn a_whole_word_does_not_match_inside_an_identifier() {
        // Rejected on both sides: `cfn` has a word character before the match and `fn_pointer`
        // one after, so only the leading `fn` is a word.
        assert_eq!(
            find_all("fn helper() { let cfn = fn_pointer; }", "fn", &WORDS),
            vec![(0, 2)]
        );
        assert!(find_all("redefine()", "define", &WORDS).is_empty());
        assert!(find_all("some_name", "name", &WORDS).is_empty());
        // Punctuation either side is a boundary; that is the case the rule exists for.
        assert_eq!(find_all("(name)", "name", &WORDS), vec![(1, 5)]);
    }

    #[test]
    fn a_non_ascii_letter_is_part_of_a_word() {
        // The byte before `x` is the tail of `\u{e9}`, which a naive ASCII test reads as a
        // boundary and so reports a whole-word hit in the middle of a word.
        assert!(find_all("caf\u{e9}x", "x", &WORDS).is_empty());
    }

    #[test]
    fn context_is_clipped_on_character_boundaries() {
        let path = WirePath::parse("C:/w/a.rs").expect("path");
        let line = format!("{}needle{}", "\u{e9}".repeat(200), "\u{e9}".repeat(200));
        let hits = search_text(&line, &path, "needle", &PLAIN);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].before.chars().count(), CONTEXT_CHARS);
        assert_eq!(hits[0].after.chars().count(), CONTEXT_CHARS);
    }

    #[test]
    fn a_line_number_counts_only_real_line_breaks() {
        let path = WirePath::parse("C:/w/a.rs").expect("path");
        let hits = search_text("one\r\ntwo\r\nneedle\r\n", &path, "needle", &PLAIN);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 3);
        // The `\r` is not part of the line, so it is not part of the context either.
        assert_eq!(hits[0].after, "");
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        assert!(find_all("anything", "", &PLAIN).is_empty());
    }

    #[test]
    fn a_binary_file_is_not_searched() {
        let dir = TempDir::new("binary");
        dir.write("shipped.exe", b"needle\0\0\0needle");
        dir.write("notes.txt", "needle");

        let found = dir.search("needle", &PLAIN);
        assert_eq!(found.matches.len(), 1, "the binary's hits must not be listed");
        assert_eq!(found.searched, 1);
        assert!(found.matches[0].path.to_string().ends_with("notes.txt"));
    }

    #[test]
    fn a_file_the_editor_would_refuse_is_skipped() {
        let dir = TempDir::new("refused");
        // Invalid UTF-8 with no NUL, so it gets past the binary gate and has to be caught by
        // the decode -- `read_file` rejects it too, so a hit here could not be opened.
        dir.write("broken.txt", [b'n', b'e', b'e', b'd', 0xff, 0xfe]);
        // Over the size cap without writing eight megabytes: the length is checked before the
        // read, so the padding never has to exist. The text comes first and is longer than the
        // binary gate looks, so size is the only thing that can reject this one.
        dir.write("huge.txt", "needle\n".repeat(1_200));
        fs::OpenOptions::new()
            .write(true)
            .open(dir.0.join("huge.txt"))
            .and_then(|file| file.set_len(MAX_FILE_BYTES + 1))
            .expect("cannot grow the scratch file");
        dir.write("fine.txt", "needle");

        let found = dir.search("need", &PLAIN);
        assert_eq!(found.searched, 1);
        assert_eq!(found.matches.len(), 1);
    }

    #[test]
    fn vendor_and_gitignored_paths_are_not_searched() {
        let dir = TempDir::new("ignored");
        dir.write(".gitignore", "secret.txt\n");
        dir.write("secret.txt", "needle");
        dir.write("node_modules/pkg/index.js", "needle");
        dir.write("target/debug/build.log", "needle");
        dir.write("src/main.rs", "needle");

        let found = dir.search("needle", &PLAIN);
        assert_eq!(found.matches.len(), 1);
        assert!(found.matches[0].path.to_string().ends_with("src/main.rs"));
    }

    #[test]
    fn hitting_the_cap_is_said_rather_than_hidden() {
        let dir = TempDir::new("cap");
        // Two files so the cap can be reached mid-walk, which is the case the stop flag is for.
        for name in ["a.txt", "b.txt"] {
            dir.write(name, "needle\n".repeat(MAX_MATCHES));
        }

        let found = dir.search("needle", &PLAIN);
        assert!(found.truncated);
        assert_eq!(found.matches.len(), MAX_MATCHES);
    }

    #[test]
    fn an_answer_that_exactly_fills_the_cap_is_not_called_truncated() {
        // The off-by-one that matters to a person: told "the first 2000, narrow it", you narrow
        // a query that had already shown you everything.
        let dir = TempDir::new("exact");
        dir.write("a.txt", "needle\n".repeat(MAX_MATCHES));

        let found = dir.search("needle", &PLAIN);
        assert_eq!(found.matches.len(), MAX_MATCHES);
        assert!(!found.truncated);
    }

    #[test]
    fn results_are_grouped_and_counted_by_file() {
        let dir = TempDir::new("grouped");
        dir.write("a.txt", "needle\nnope\nneedle\n");
        dir.write("b.txt", "needle\n");
        dir.write("c.txt", "nothing here\n");

        let found = dir.search("needle", &PLAIN);
        assert_eq!(found.matches.len(), 3);
        assert_eq!(found.files, 2);
        assert_eq!(found.searched, 3, "every readable file is walked, match or not");
        // Sorted, so the same search never lists its files in a different order.
        let paths: Vec<String> = found
            .matches
            .iter()
            .map(|hit| hit.path.to_string())
            .collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn a_search_with_no_workspace_walks_nothing() {
        // The command's own early return, asserted directly: building a
        // `State<'_, WorkspaceState>` needs a running app, and what is worth pinning is that
        // the answer is zeros rather than an error the pane would have to find words for.
        let found = empty();
        assert_eq!(found.searched, 0);
        assert_eq!(found.files, 0);
        assert!(!found.truncated);
        assert!(found.matches.is_empty());
    }
}
