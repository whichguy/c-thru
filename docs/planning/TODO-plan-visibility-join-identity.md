# TODO: plan-visibility join identity

`native<->wave` join is repo-basename + newest-oplus-newest pairing, which
mispairs two concurrent same-repo-basename sessions. A correct fix requires
wave manifests to carry `cwd`/`session_id` identity (a `parseWaveMd` /
wave-writer schema change) — cross-cutting and out of this round's scope. The
naive “exactly 1 native + 1 wave” count-based guard that was considered instead
would break the currently green baseline test
(`test/plan-state-lib.test.js:79-91`): it seeds `repo-alpha` with 2 natives + 2
waves and asserts the newest joins newest while older entries become history.
A strict count guard fails that case.

Evidence: `tools/plan-state-lib.js:284-293` (the pairing logic),
`test/plan-state-lib.test.js:79-91`, and `parseWaveMd`'s field set (no
`cwd`/`session_id` carried) in `tools/c-thru-plan-harness.js`.
