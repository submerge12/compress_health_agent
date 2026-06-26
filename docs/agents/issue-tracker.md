# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for
issue operations from inside this clone.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run
inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External PRs run through the same labels and states as issues. Collaborators'
in-flight PRs are left alone.

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only `authorAssociation` values of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit --add-label` or `--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either. Resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`, unless the ticket is known to be a PR.
