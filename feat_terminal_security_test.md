# Terminal output and Node 20 regression checks

Run from ts/:

- `npm test`: builds the current source and runs all tests.
- `npm run typecheck`: checks production TypeScript.
- `npm exec --yes --package=node@20 -- node test/run.mjs`: tests with Node 20.

## Cases

- Directory, branch, host and summary contain OSC 52 sequences. Displayed
  cells must contain no sequence; the input session must stay unchanged.
- Machine names and errors contain controls. Remove them before display.
- A synthetic Codex session has controls in its directory and ID. Sanitize
  --list output; parsing --json must restore the original values.
- Existing web security, Python parity and SSH response tests remain green.

The fixture uses a temporary home and explicit CODEX_HOME and CLAUDE_CONFIG_DIR.
It does not resume an agent or connect to a host.

## Results and limits

The 54-test suite passed on the current Node runtime and Node 20.
Production compilation and type checking passed.
No live Windows terminal or real remote resume was exercised.
The test loader uses Node's experimental loader hook, which emits a warning.
Rerun after changing formatting, metadata handling, sanitization or test loading.
