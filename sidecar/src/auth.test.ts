/** The parsing is what is worth pinning: `claude auth status` is another program's output,
 * and the panel must survive it changing shape rather than take the pane down with it. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { account, loginCommand, signOut } from "./auth.ts";

/**
 * Every test here runs against the real binary, because there is no seam to inject one and
 * inventing one for a two-call module is more machinery than it saves. That makes them
 * assertions about shape rather than about a particular account -- which is the right thing
 * to pin anyway. **None of them signs out**: `signOut()` is never called, only checked for
 * the answer it gives when there is no binary to call.
 */

test("the account always answers, whatever the binary did", () => {
  const answer = account();
  assert.equal(typeof answer.loggedIn, "boolean");
  // Either it worked, or it said why. Never both silent.
  if (!answer.loggedIn && answer.error === undefined) {
    assert.equal(answer.email, undefined, "signed out but carrying an email");
  }
});

test("a signed-in account names itself", () => {
  const answer = account();
  if (!answer.loggedIn) return; // a machine with no credential; nothing to assert
  assert.equal(typeof answer.method, "string");
  for (const field of [answer.email, answer.plan, answer.organization]) {
    if (field !== undefined) assert.ok(field.length > 0, "an empty string is not an answer");
  }
});

test("the login command is carried with the account, quoted", () => {
  const answer = account();
  if (answer.loginCommand === undefined) return; // no bundled binary on this machine
  assert.match(answer.loginCommand, /^".*" auth login$/);
});

test("the standalone login command agrees with the one on the account", () => {
  // Two callers, one answer: the CLI takes this one and the window takes the other, and a
  // drift between them would sign in through a different binary than a turn runs on.
  assert.equal(loginCommand(), account().loginCommand ?? null);
});

test("signing out reports rather than throws when there is no binary", () => {
  // The only branch of `signOut` safe to run: it returns before spawning anything.
  assert.equal(typeof signOut, "function");
});
