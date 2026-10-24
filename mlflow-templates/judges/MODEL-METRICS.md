# Judge instructions (MLflow `make_judge` / Judge Builder)

Each judge below is one criterion. Paste the instructions into the Judge Builder
"Instructions" field, or pass them as `instructions=` to `make_judge()`.
Every judge uses at least one of the allowed variables
(`{{ inputs }}`, `{{ outputs }}`, `{{ expectations }}`, `{{ trace }}`).

## What goes into each variable

| Variable | Contents |
|---|---|
| `{{ inputs }}` | The task prompt given to the agent (the contents of the prompt file). |
| `{{ outputs }}` | One compact object, built per run (see below). |

Suggested shape for `outputs`. Keep it small, and strip model names, config names
and harness identifiers so the judge stays blind:

```json
{
  "diff": "<contents of diff.patch>",
  "final_response": "<contents of RESPONSE.md, trimmed>",
  "tools_available": ["tool_a", "tool_b"],
  "tools_called": [
    {"name": "tool_a", "args": "<truncated>", "is_error": false}
  ],
  "metrics": {
    "tests_passed": 0,
    "tests_total": 0,
    "tests_failed": 0,
    "godot_tests_ok": 1,
    "tool_calls": 0,
    "tool_errors": 0,
    "diff_files": 0,
    "diff_lines_added": 0,
    "diff_lines_removed": 0
  }
}
```

Leave `duration_s` and token counts out of the scored judges. They aren't about
quality, and they invite the judge to reward or punish speed and cost.

## Shared preamble

Every judge starts with this block so the instructions stay consistent.

```
You are an impartial code-review judge evaluating one AI agent's attempt at a
Godot project change. You are not told which model or setup produced it. Judge
only the evidence provided. If evidence needed for a score is missing (for
example the diff is empty or absent), say so and score low rather than guess.
Do not reward length or confident wording. Cite specific evidence (file and
line from the diff, or a named tool call) in your rationale.

Task given to the agent:
{{ inputs }}

Agent result (diff, final response, tools, and objective run metrics):
{{ outputs }}

The metrics inside the result are ground truth. Do not re-estimate them.
```

---

## 1. correctness

**Output type:** `int` (1 to 5)

```
<shared preamble>

Question: Does the diff fulfill the task exactly as written?

Check each requirement in the task against the diff, one by one. Passing tests
does NOT by itself mean a 5: tests may not cover every stated rule. A diff that
is empty, or only touches unrelated files, is a 1.

Scale:
1 = does not address the task, or the diff is empty
2 = addresses a small part; major requirements missing or wrong
3 = partially fulfills it; clear gaps or likely bugs
4 = fulfills it with minor gaps
5 = fully and robustly fulfills every stated requirement

In your rationale, list which requirements are met and which are not.
```

## 2. scope_discipline

**Output type:** `int` (1 to 5)

```
<shared preamble>

Question: Are the changes limited to what the task asked for?

Look at which files were touched and what changed in them (see diff_files and
the line counts in the metrics). Penalize unrelated refactors, renamed or
deleted existing code, edits to project settings, and changes to existing tests
that weaken them. New tests and helpers that directly support the task are fine.

Scale:
1 = large unrelated edits or deletions
2 = several unrelated changes
3 = minor extras mixed in
4 = focused, with one small extra
5 = tightly scoped; every change traces back to the task

In your rationale, name any change you consider out of scope.
```

## 3. code_quality

**Output type:** `int` (1 to 5)

```
<shared preamble>

Question: Is the added or changed GDScript good Godot code?

Consider: idiomatic GDScript and Godot conventions (signals over polling,
typed variables where the surrounding code uses them, sensible node and scene
usage), readability, naming, consistency with the surrounding code, and
absence of dead code, debug prints, or obviously fragile logic. Judge only
what is in the diff. Do not judge whether the task was fulfilled; that is a
different judge.

Scale:
1 = broken, unreadable, or clearly against Godot practice
2 = works at best by accident; many quality problems
3 = acceptable, with several notable issues
4 = good, with minor nits
5 = clean, idiomatic, and consistent with the codebase

In your rationale, cite specific lines from the diff.
```

## 4. tool_use

**Output type:** `Literal["appropriate", "missed_opportunities", "wasteful", "n/a"]`

Use `n/a` only when no tools were available.

```
<shared preamble>

Question: Given the tools available to the agent, was its tool usage appropriate?

Compare tools_available with tools_called. Consider:
- Did the agent use tools that fit the task (for example project inspection,
  documentation lookup, or running tests) when doing so would plausibly have
  helped?
- If available tools were never used, would using them plausibly have
  improved the result? Say which ones and why.
- Were there wasteful patterns: repeated identical calls, retrying a failed
  call unchanged, or many calls with errors (see tool_calls and tool_errors)?

Definitions:
appropriate = tool use matched what the task needed
missed_opportunities = available tools would plausibly have helped but were not used
wasteful = excessive, repeated, or failing tool calls
n/a = no tools were available

Do not penalize an agent for skipping a tool that would not have helped.
In your rationale, name specific tools and calls.
```

---

## Optional: a trace-based judge

Only applies if you log real MLflow traces. A judge that uses `{{ trace }}`
explores spans itself and needs an explicit `model` that supports tool calling.
Don't mix it with `{{ inputs }}` / `{{ outputs }}` in the same template.

**Output type:** `Literal["optimal", "good", "suboptimal", "poor"]`

```
Analyze the tool usage in {{ trace }}.

Check for:
1. Unnecessary tool calls
2. Wrong tool selection (a better tool was available)
3. Repeated identical calls, or retries after a failure without changing the input
4. Missing tool usage (a tool should have been used)

Cite specific spans. Rate overall efficiency as optimal, good, suboptimal, or poor.
```

---

## Notes

- Log judge scores back as `judge_<name>` metrics (for example `judge_correctness`)
  and keep the rationale as an artifact or tag. Don't use the `eval_` prefix,
  which your evaluation form owns.
- Keep temperature at 0 on the judge model.
- Sanity checks without human scores: broken runs (`tests_failed` > 0) should
  mostly score lower on correctness; an empty diff should score 1; re-judging
  the same runs twice should not swing by 2 or more points.
