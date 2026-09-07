import assert from "node:assert/strict";
import test from "node:test";

import { authHint } from "../src/remote.ts";

test("authHint maps host-key failures to an accept-the-key hint", () => {
  const hint = authHint("Host key verification failed.", "user@box");
  assert.match(hint ?? "", /ssh user@box/);
});

test("authHint maps permission-denied to an ssh-add hint", () => {
  const hint = authHint("git@box: Permission denied (publickey).", "user@box");
  assert.match(hint ?? "", /ssh-add/);
});

test("authHint returns undefined for non-auth failures", () => {
  assert.equal(authHint("bash: python3: command not found", "user@box"), undefined);
  assert.equal(authHint("", "user@box"), undefined);
});
