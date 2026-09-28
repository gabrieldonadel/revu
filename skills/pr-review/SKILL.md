---
name: pr-review
description: Review one GitHub pull request against the target repository's design intent. If the repository carries an LLP corpus, orient on it first and check the diff against the referenced decisions and @ref drift; otherwise run a correctness-and-quality review. Never posts to GitHub.
source: revu default skill
---

# pr-review

Review the pull request checked out in the current worktree. The diff range,
base and head SHAs, title, body, and existing review comments are provided
in the task prompt.

## Trigger

revu runs this skill on demand for one pull request. It is the default skill;
the user may select another from `~/.config/revu/skills/`.

## Invariants

- MUST NOT post anything to GitHub. The output is shown to the user first;
  posting is their click.
- MUST NOT report a finding it cannot point to a file and line for.
- MUST state the base and head SHAs reviewed at the top of the output.
- MUST NOT claim to have run tests or builds it did not run.
- MUST keep the whole output under 1,500 words; findings first, praise last.

## Workflow

1. **Orient.** If an `llp/` directory exists at the repository root, read its
   root document (`llp/0000-*` or the lowest-numbered explainer) and the
   documents that cover the systems the diff touches. Collect every `@ref LLP
   NNNN` comment inside the changed files and read the referenced sections.
2. **Read the diff** in full. For each hunk, ask: does the change still
   satisfy the decision its `@ref` points at? Does it change behaviour a
   referenced document specifies? Does it remove or move an `@ref` without
   updating the document?
3. **Correctness pass.** Data flow, error paths, concurrency, resource
   lifetime, input validation. Read surrounding code when a hunk's meaning
   depends on it.
4. **Quality pass, briefly.** Duplication of something the repo already has,
   naming that contradicts the surrounding code, tests missing for changed
   behaviour.
5. **Write the review** (see Artifact). If step 1 found no `llp/`, say so in
   one line and skip the drift section.

## Artifact

Markdown with these sections, in order:

- **Reviewed:** `base..head`, files touched, whether an LLP corpus was used.
- **Blocking** — findings that should stop the merge, each with
  `path:line`, what is wrong, and what would resolve it.
- **Design drift** — code that no longer matches a referenced LLP section
  (`LLP NNNN §x`), or an `@ref` that is now stale. Omit if none.
- **Suggestions** — non-blocking improvements, each with `path:line`.
- **Questions for the author** — things the diff does not let you decide.
- **Summary** — two or three sentences; recommend approve / request changes /
  comment.

## Hand-offs

- A finding that is really a design change → suggest the author open an LLP
  in the target repo; do not draft it here.
- A repo-wide problem the diff merely exposes → one line in Questions, not a
  blocking finding.
