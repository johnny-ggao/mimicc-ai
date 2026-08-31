---
name: research
description: Structured deep research on a question the repository cannot answer — plan the angles, search, read primary sources in full, cross-check, then report with citations. Use when one search will not settle it.
requires: WebSearch, WebFetch
---

A method, not a mandate: size the depth to the question. One fresh fact needs one
search; a real investigation earns the phases below.

## Work in phases

1. **Scope.** Break the question into the two-to-four sub-questions that would
   settle it, and name what kind of evidence settles each. Write the angles down
   before searching — a search without a question finds whatever ranks well.
2. **Sweep.** WebSearch each angle. Snippets only locate sources: use this phase
   to find what is worth reading, not to answer.
3. **Read.** WebFetch the most promising sources and actually read them — a
   snippet is not a page. A large page comes back as a synopsis with a file
   path; Read that path when the details matter.
4. **Cross-check and close.** A claim two independent sources agree on is a
   finding; a claim one source makes is a lead, and gets flagged as such.

## Delegate the heavy reading

When phases 2–3 mean many pages or several angles, dispatch `research`
subagents with Task — one bounded sub-question each, several in one turn. Their
reading fills their context, not this conversation; you get findings with
citations back. State each objective in full: a subagent starts blind.

## Match time precision to the question

| The question says   | Search with                                  |
| ------------------- | -------------------------------------------- |
| today / right now   | the date itself in the query, recency `day`  |
| this week / latest  | recency `week`                               |
| recent / lately     | recency `month`                              |
| this year / current | the year in the query, recency `year`        |
| (no time words)     | no recency filter — do not invent an urgency |

Asking "today" questions with year-level queries is how stale answers happen.

## Mix the information types

A solid answer usually draws on several of: hard figures, concrete cases,
expert judgment, trends over time, comparisons, criticisms and limits. When
everything you have is one type, sweep once more from a missing angle.

## Before writing, check

- Every load-bearing claim carries a source URL, cited as
  `[citation:Title](URL)`, with the publish date where timing matters.
- Time-sensitive numbers come from the newest source that answers.
- Single-source claims are flagged as single-source.
- What you could not establish is stated plainly — a gap named is a finding.
