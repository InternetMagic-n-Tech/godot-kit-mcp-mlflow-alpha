<!-- Tool Calls Here: https://raw.githubusercontent.com/beremaran/godot-agent-loop/refs/tags/v3.0.1/docs/tools.md -->

First, read the existing scene and scripts (use list_project_files and read_file) to fully understand the current tile/piece data structure and match-detection logic before changing anything.

Task: Add exactly ONE new special tile type, called 'special_four', with these exact rules:
- It is a DUPLICATE of one existing tile's base sprite/scene, not a brand new unrelated texture — copy an existing tile's visuals as the starting point.
- Make it visually distinguishable from the tile it was copied from of by: changing its background/matte yellow color (to make it glow) and adding a Label/text node displaying '4' on top of the sprite.  Be aware of hover & transitions as well.
- This tile type must ONLY clear when the match-checking logic finds 4 or more in a row/column of THIS SPECIFIC tile type.
- This tile type must be EXCLUDED from the normal 3-match check entirely — 3 of this tile in a row must NOT clear, under any circumstance. Do not implement this as '3 or more, except also allow 4' — implement it as a genuinely separate rule: this tile type skips the 3-match check and is evaluated only against a 4-match check.
- All other existing tile types are completely unaffected and keep their standard 3-match-or-more clear behavior exactly as before.

Implementation process (follow in order, don't skip steps):
1. Read and understand the existing code first.
2. Make the changes.
3. Run verify_project on every script you modified. If it reports ANY error, fix it and run verify_project again. Do not proceed until verify_project reports zero errors.
4. Run run_project, then verify_project, to confirm the game launches and the board still works with no runtime errors.
5. If verify_project reports an error or times out, investigate using game_get_errors/game_get_logs before concluding, rather than assuming success.

Do not report the task as complete unless you can show the actual tool output proving verify_project passed and the project ran without errors. If you cannot get a clean validation/run, say so explicitly rather than claiming success.
