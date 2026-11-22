[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/koejanvok-oss/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/koejanvok-oss/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is one patch tool for every AI edit format: it reads a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON, finds the lines each edit names even when the model drifted their whitespace or indentation, and changes every file or none.

- Four formats, one command: `node main.ts [options] [PATCH]`
- Three matching tiers: exact, trailing-whitespace tolerant, then indentation tolerant with re-indentation
- All or nothing: a failed edit changes nothing, and every failure is reported
- `--check` previews without writing; `--strict` matches exactly; `--format` pins the format

## Run it

```sh
node main.ts [options] [PATCH]
```

`SPEC.md` is the whole specification. `check.ts` runs the practice set on your own machine:

```sh
node check.ts ../program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=koejanvok-oss&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
