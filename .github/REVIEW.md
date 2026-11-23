# Notes for the reviewer

Guidance for `pi-review`. `claude-review` reads this pull request too, and the two are
deliberately not doing the same job: that one reads the diff and the files, this one can run
them. Read `AGENTS.md` and the spec row the change cites first; this file says only where
your turns are worth spending.

## What the other reviewer covers

Do not spend turns on any of this. It is the whole of what the other reader does, and it
reads faster than you do.

- `CHANGELOG.md` and docs prose, and whether the paperwork a change owes is present.
- Whether a spec row exists, and whether a test name cites its ID as a whole component.
- Test titles, test names, and "this title claims more than its assertions check".
- Workflow YAML: permissions, action versions, timeouts, concurrency groups.
- Style, structure, "consider extracting", speculative performance.

It has no shell. You do. That is the difference worth paying for, so spend your turns where
it applies.

## What to spend your turns on

Run the thing. A finding you demonstrated outranks three you reasoned about, and the two
real bugs this reviewer has found on this repository both came from running the code the
pull request gave it and doing that code's arithmetic.

1. **Reproduce the bug the pull request says it fixed.** The checkout is the head, and it
   stays untouched: copy it elsewhere (`git archive HEAD | tar -x -C /tmp/lyra-revert`, or a
   `git worktree` under `/tmp`), revert the fix there, and run the test that is supposed to
   guard it. Put the failure in the comment. A regression test that passes against the code
   it was written to catch is the most common real defect in this repository.
2. **Run the gate step the pull request reports.** The fuzz target, the suite, the script.
   Compare what it prints to the figures in the body. A body that does not match the tree is
   a finding; a body that matches it is a reason to trust the rest.
3. **Derive the arithmetic.** Any comment that asserts a count, a byte length, a boundary, a
   budget or a timeout is a claim you can check by computing it. Both real bugs found here
   were an off-by-a-few at an edge: a cap of 200 measured against 201 bytes, a marker
   measured wider than the one the entry would carry.
4. **Ask of every new test: delete the changed lines. Does it still pass?** If it does, the
   test is not testing the change, whatever its title says.
5. **For anything that decides green or red, read the exit code and the report shape it
   reads.** A script that reports success on a failed run is the highest-severity finding
   this repository has, because the gate is the definition of done and this is the failure
   that makes the gate stop meaning anything.

## Reporting

Post only what you ran, with the command and its output. If you could not reproduce
something, say so in one line, or drop it. Two demonstrated findings beat ten plausible ones,
and "nothing found" is a good review when it is true.
