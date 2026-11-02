# Issue tracker

Use beads (`bd`) for decisions, specs, implementation tickets, dependencies, and status. Run `bd prime` at session start and load the project-local beads skill when working with the tracker.

## Work selection

Use structured output: `bd ready --json`, `bd show <id> --json`, and `bd list --json`. Claim implementation work with `bd update <id> --claim` before editing. Close a ticket only after its acceptance criteria have supporting checks. Record the commands that ran and any remaining blockers.

## Records and dependencies

- Store decisions as `decision` beads. Store the spec as an `epic` with the `spec` label, and implementation slices as its children.
- Use `bd create --parent <id>` for children. Add blockers with `bd dep add <dependent> <prerequisite>`. Parent links do not replace blocking dependencies.
- Refer to records by title, with the bead ID alongside it. Read the exact record instead of deriving state from its rendered Markdown.
- Record decisions once in their beads. Development documents link to those records rather than restating their detail.
- Apply `ready-for-agent` to approved implementation tickets. Use the triage vocabulary in `triage-labels.md` for incoming work.

## Wayfinding operations

When a broad effort needs a decision map, create an `epic` labelled `wayfinder:map`. Create child decision tickets with `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. These records carry only `wayfinder:*` labels, not triage labels.

Query children and their dependency, status, and assignee fields. The frontier consists of open, unclaimed children whose blocking prerequisites are closed. Claim before work. Record a resolution comment, close the decision ticket, and add its title, ID, and one-line summary to the map. Keep unresolved questions separate from out-of-scope work.

## Storage and handoff

The local embedded Dolt database is the source of truth. JSONL exports are for interchange, not a substitute for Dolt backup or remote synchronization. Report an unconfigured sync destination as a blocker to cross-machine planning continuity.

Git commits, pushes, releases, and Dolt remote synchronization require explicit user authorization. Report proposed commands when that approval is absent. Beads initialization is already complete; use this database rather than running initialization again.

## Pull requests

Pull requests are not an incoming triage surface for this project.
