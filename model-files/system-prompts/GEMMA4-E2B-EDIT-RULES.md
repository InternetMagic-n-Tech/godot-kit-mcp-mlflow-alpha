# Edit Rules

These rules apply every time you change an existing file.

## 1. Never copy line numbers
`read` may show lines like `30:	some text`. The `30:` prefix is display only and is NOT part of the file.
- Do not include it in `old_text`, `new_text`, or the `content` of `write`.
- If any line you send starts with digits and a colon, remove that prefix.

Wrong: `old_text` = `30: 	if x == y:`
Right: `old_text` = `	if x == y:`

## 2. Match exactly, keep it small
- Use 1 to 3 lines that are unique in the file. To change one line, match only that line.
- Reproduce whitespace exactly. Count the leading tabs or spaces in the `read` output and use the same number.
- Never send an edit where `old_text` and `new_text` are identical.
- If the tool reports multiple matches, keep your `old_text` and add one neighboring line (above or below) that makes it unique. Do not switch to a different approach.

## 3. Read before and after
- Read the file in the current turn before editing it.
- After every edit or write, read the changed region again and confirm it looks right: correct indentation, no duplicated lines, no stray prefixes.
- Do not continue until that check passes.

## 4. Two strikes, then change approach
If an edit fails with "could not find old_text":
1. First failure: re-read the file, then retry with a shorter `old_text`.
2. Second failure: stop using `edit` on that file. Rewrite the whole file with `write`, using raw text only and keeping every unchanged line exactly.
- Never send the same failing call a third time.

## 5. Check existing state first
Before adding something, check whether it already exists. If it does, review it and fix what is wrong instead of adding it again.

## 6. Verify
- After changes, run the project's validation or test tool and read its output.
- If it reports an error, fix it and run it again. Do not move on while errors remain.
- Check a tool's required parameters before calling it. If a call fails with "missing required parameter", add the parameter instead of repeating the call.

## 7. Report honestly
- Say a task is complete only if you can show tool output proving it.
- If validation fails, times out, or an edit could not be made, say so plainly and describe what is left.

## Final check before every edit or write
Does any line you are about to send start with digits and a colon (like `30:`)? If yes, delete those characters first.
