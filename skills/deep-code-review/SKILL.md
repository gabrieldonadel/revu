---
name: deep-code-review
description: In-depth design-focused code review - understands codebase context before evaluating PR changes, posts structured feedback to GitHub
---

# Deep Code Review

**Core principle: Context before critique.** Never evaluate changes without understanding the existing architecture.

## Usage

```
/deep-code-review <PR_URL>
/deep-code-review <PR_URL> --iteration 2
```

## Phase 1: Fetch & Context

**Fetch PR metadata and diff:**
```bash
gh pr view <PR_URL> --json title,body,additions,deletions,changedFiles,author,headRefOid
gh pr diff <PR_URL>
```

**Targeted exploration** - only investigate what's directly relevant to the changed code:
- Read current versions of changed files
- Find direct callers/consumers of modified APIs
- Search for similar patterns if the PR introduces new ones
- Check existing tests for changed modules

Use Task(Explore) for architectural context, but scope it narrowly to the changed areas.

**Do NOT exhaustively explore** the entire codebase. Focus on what's needed to evaluate this specific PR.

## Phase 2: Analyze

Evaluate the diff against the context gathered. Single checklist:

- **Design fit** - Respects module boundaries? Follows existing patterns? Appropriate abstraction level?
- **Complexity** - Simplest viable solution? YAGNI violations? Over/under-engineered?
- **Correctness** - Edge cases handled? Race conditions? Resource cleanup?
- **Security** - Input validation? Injection? Auth? Secrets exposure?
- **Performance** - N+1 queries? Unbounded growth? Blocking operations?
- **Testing** - Coverage adequate? Happy path + edge cases + error cases?
- **Breaking changes** - API contracts preserved? Migration needed?

For each finding, classify severity:
- `critical` - Security, data loss, breaking changes. Must fix.
- `design` - Architectural concerns, pattern violations. Should fix.
- `suggestion` - Improvements worth considering. Nice to fix.
- `nit` - Minor style/readability. Take it or leave it.

## Phase 3: Output

Write findings to `/tmp/deep-code-review-{pr_number}.json`:

```json
{
  "pr_url": "https://github.com/owner/repo/pull/123",
  "owner": "owner",
  "repo": "repo",
  "pull_number": 123,
  "summary": "Review summary in markdown...",
  "verdict": "APPROVE | REQUEST_CHANGES | COMMENT",
  "comments": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "Description with reasoning (do NOT include severity labels in body — the posting script prepends them automatically from the severity field)",
      "severity": "critical",
      "line_content": "unique substring from the target line"
    }
  ]
}
```

**IMPORTANT — `line_content` field:** Always include `line_content` with a unique substring from the target line of code. The posting script fetches the PR diff, searches for this substring, and resolves the correct line number — protecting against miscounted line numbers. The `line` field is used as a hint when multiple matches exist. During preview, the script shows the actual code at each target line so you can verify placement before posting.

After writing the JSON file:
1. Show the user a summary: verdict, comment count by severity, and key findings
2. User can inspect/edit the JSON at the temp path
3. Preview what will be posted: `bun run ~/.claude/skills/deep-code-review/post-review.ts preview /tmp/deep-code-review-{pr_number}.json`
4. Stage the review as PENDING: `bun run ~/.claude/skills/deep-code-review/post-review.ts post /tmp/deep-code-review-{pr_number}.json`
5. The user can then edit inline comments on GitHub before submitting
6. Submit from GitHub UI, or via CLI: `bun run ~/.claude/skills/deep-code-review/post-review.ts submit /tmp/deep-code-review-{pr_number}.json <review_id> [APPROVE|REQUEST_CHANGES|COMMENT]`

The posting script stages reviews as **PENDING** (draft), so the user can edit inline comments on GitHub before submitting. The suggested verdict is shown in the summary body for reference.

## Iteration Support

When `--iteration N` is specified:
1. Fetch new commits since last review: `gh pr view <PR_URL> --json commits`
2. Check conversation for addressed comments: `gh api repos/{owner}/{repo}/pulls/{pr}/comments`
3. Re-analyze only changed areas; acknowledge fixes, flag new issues
4. Write a new JSON file and post as usual

## Guidelines

**DO:**
- Explore before critiquing
- Provide reasoning for every comment
- Reference existing codebase patterns
- Ask questions when intent is unclear
- Acknowledge trade-offs

**DON'T:**
- Review without understanding context
- Focus on style/syntax over design
- Suggest changes without reasoning
- Give performative praise
- Accept complexity without justification
- Make absolute statements without evidence
