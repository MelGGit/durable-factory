---
name: factory
description: Drive Durable Factory runs and planning from a terminal with the `factory` CLI. Use when asked to plan work, start, watch, answer, pause, resume or cancel a factory run, check what a run needs, or open a run's worktree.
---

# Durable Factory CLI

Run it from the factory repository with `bun run factory <command>`. Add `--json` to every command and read that output instead of the text form.

Settings: `DURABLE_FACTORY_URL` (default `http://127.0.0.1:4317`), `DURABLE_FACTORY_API_TOKEN` and `DURABLE_FACTORY_PROJECT`. The service must already be running.

## Runs

| Command                                | Does                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `runs`                                 | List runs.                                                                      |
| `show <run>`                           | One run: status, stage, pending question, worktree, branch.                     |
| `wait <run> [--for a,b] [--timeout s]` | Block until the run needs you; see exit codes.                                  |
| `watch [<run>]`                        | Stream changes, one JSON line each.                                             |
| `start <issue>`                        | Start a run for a GitHub issue number.                                          |
| `pause`/`resume`/`cancel <run>`        | Control a run.                                                                  |
| `answer <run> <text>`                  | Answer the pending question.                                                    |
| `send <run> <text> [--steer]`          | Send the developer a follow-up, or redirect it with `--steer`.                  |
| `open <run> [--pause]`                 | Open a terminal in the worktree if the environment can; else print what to run. |

A `<run>` is an id or a unique id prefix. Exit codes: 0 ok, 1 failed, 2 usage, 124 `wait` timed out.

## Planning

A run starts from an approved plan: a chat with the planner produces a ticket, which becomes a GitHub issue once approved.

| Command                     | Does                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `plan list`                 | Planning conversations and their ids.                                                           |
| `plan new <title>`          | Open one; prints its id.                                                                        |
| `plan send <id> <text>`     | Say something, wait until the planner has answered, print the reply, ticket draft and review.   |
| `plan show <id>`            | The same view without sending.                                                                  |
| `plan approve <id>`         | Approve creating the issue. Only works after the planner has proposed one (`awaitingApproval`). |
| `plan chat <id>`            | Interactive chat for a person; `/` opens a command menu. Agents must not use it.                |
| `start --conversation <id>` | Start a run from the approved plan.                                                             |

Read the ticket and the `review` findings with the person before `approve`; approving creates a real GitHub issue.

## Environment

Inside Orca the CLI opens terminals and shows run state in Orca; in any other terminal it does neither, and `open` prints the commands to run. It is detected from the terminal; force it with `--env orca|none` or `FACTORY_ENV`. `watch --no-env` stops `watch` from writing state into the environment.

## Working rules

- Use `wait` instead of polling `runs`. By default it returns on `needs_input`, `paused`, `pr_ready`, `cancelled` or `termination_blocker`.
- When `show` has a `question`, read it and answer with `answer`. If `question.acceptsAnswer` is false, a typed answer is refused; use `resume` once the cause is dealt with.
- Never edit a run's worktree while `worktreeBusy` is true. The developer agent writes the same files. `pause` the run and `wait --for paused` first.
- A run's candidate is validated as a whole. Edits made outside a stage are not part of it, so after `pr_ready` push follow-up commits yourself and do not expect the run to pick them up.
- `start`, `plan approve` and `cancel` have effects (model usage, a GitHub issue or pull request, discarded work). Do them only when asked.
- Stray files in a worktree can block automatic cleanup after merge; `show` reports `cleanup.state: blocked` with the reason.
