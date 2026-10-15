---
name: upstream-sync
description: Review new commits in the upstream Clone Hero Chart Manager repo (xlzipx/clone-hero-chart-manager, remote `upstream`) since the last review, summarize what each changes for users, map them to this fork's files, let the user pick which to fold in, and record every decision. Use when the user asks to check upstream, see what ZIPEEK changed, sync or fold in upstream changes, or "what's new upstream".
---

# Upstream sync

This repo is a personal fork that is being rewritten (Vue 3 + JavaScript instead of React + TypeScript), so upstream
commits usually **cannot be cherry-picked**. The job is to show the user what changed upstream, let them choose, and
re-implement the chosen behaviour in this codebase. Nothing is folded in without the user picking it.

State lives in `docs/upstream/` and is committed with the fork:
- `last-reviewed`: the upstream commit SHA up to which every commit has a recorded decision.
- `log.md`: one row per reviewed upstream commit: decision and reason.
- `file-map.md`: upstream path → this fork's path(s). Grows as the port proceeds. "same" means the file is still
  identical in spirit and a cherry-pick may work.

## Steps

1. **Fetch.** `git fetch upstream`. If the remote is missing, stop and tell the user to run
   `git remote add upstream https://github.com/xlzipx/clone-hero-chart-manager.git`.
2. **List new commits.** `BASE=$(cat docs/upstream/last-reviewed)` then
   `git log --reverse --format='%h%x09%ad%x09%s' --date=short "$BASE"..upstream/main`.
   If there are none, say so and stop. If there are more than 40, review the oldest 40 and say how many remain.
3. **Understand each commit.** For each: `git show --stat --format='%B' <sha>`, and read the diff
   (`git show <sha> -- <path>`) for the files that matter. Release commits look like `1.6.9: Short summary`;
   use them to group the commits before them into that release.
4. **Classify** each commit as one of: `feature`, `fix`, `ui-polish`, `refactor`, `build/release`, `docs/landing`.
   Note whether it touches an area this fork has ported (check `file-map.md`) or something the fork dropped.
5. **Present one table** per release group, newest group last:

   | # | Commit | Type | What changes for the user | Upstream files | Our files (from file-map) | Effort |

   - "What changes for the user" is one plain sentence, not the commit subject repeated.
   - Effort: `trivial` (constant/text), `small` (one component or function), `medium` (several files), `large`.
   - Flag fixes that look like they fix bugs this fork still has (the code exists here unchanged or was ported
     without the fix). Lead with those.
   - Mention when a later commit reverts or supersedes an earlier one, so the user doesn't pick both.
6. **Ask** which commits to fold in, using AskUserQuestion with multiSelect when there are 4 or fewer candidates,
   otherwise ask the user to reply with the row numbers. Offer "skip all" and "decide later".
7. **For each picked commit**, write a short port note in the reply: the behaviour to reproduce, where it goes in
   this fork (file + function/component), and anything that doesn't translate (React hook → Vue composable,
   zustand → Pinia, TS types → JSDoc). If `file-map.md` says "same" for every touched file, try
   `git cherry-pick -x <sha>` first and report the result. Implement only if the user asks to.
8. **Record decisions** in `docs/upstream/log.md`, one row per reviewed commit:
   `| <date reviewed> | <sha> | <subject> | picked / skipped / later | <one-line reason> |`.
   Commits marked `later` stay listed at the top of the log under "Pending" until decided.
9. **Advance the marker.** Write the newest upstream SHA whose commit and all older ones have a decision
   (`picked`, `skipped`, or `later`) to `docs/upstream/last-reviewed`.
10. Update `file-map.md` when you learn where an upstream file now lives in the fork.

## Rules

- Read-only towards upstream: never push to `upstream` (its push URL is disabled on purpose), never open PRs there.
- Don't stage or commit unless the user asks; when they do, use a message like
  `Fold in upstream <sha>: <subject>` and keep one upstream commit per fork commit where practical.
- Upstream code comments are in Czech; translate what matters in your summary, don't paste Czech at the user.
- Ignore `pages/`, landing-page and `release/` asset churn unless the user asks; list them in one summary line.
