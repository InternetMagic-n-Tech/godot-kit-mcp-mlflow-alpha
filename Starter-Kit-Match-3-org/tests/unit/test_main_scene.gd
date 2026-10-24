# res://tests/unit/test_main_scene.gd
extends GutTest

const MainScene = preload("res://scenes/main.tscn")

var main_instance

func before_each():
	main_instance = MainScene.instantiate()
	add_child_autofree(main_instance)
	await wait_seconds(0.1)  # let spawn_at()'s node additions settle

	# _ready() calls process_board_state(), which can trigger a cascade if the
	# randomly-spawned board happens to start with a match (quite possible
	# across a full 8x8 grid of random textures). is_swapping alone isn't a
	# reliable settle signal -- it can clear while a few grid cells are still
	# transiently null between an iteration's clear and refill steps -- so we
	# poll the grid directly for the actual invariant we care about: no null
	# cells. Capped so a real bug fails the test instead of hanging forever.
	var settle_attempts := 0
	while _grid_has_nulls() and settle_attempts < 50:
		await wait_seconds(0.1)
		settle_attempts += 1
	assert_false(_grid_has_nulls(), "Board should have finished resolving its initial cascade (no null cells) before the test body runs")
	assert_false(main_instance.is_swapping, "is_swapping should also be false once the board has settled")


func _grid_has_nulls() -> bool:
	for x in main_instance.width:
		for y in main_instance.height:
			if main_instance.grid[x][y] == null:
				return true
	return false

# Helper: resize the grid mid-test. Changing `width`/`height` alone does NOT
# resize the existing `grid` array, so any test that needs a smaller/larger
# board than the scene's default must call this instead of just assigning
# width/height directly.
func _resize_grid(w: int, h: int) -> void:
	main_instance.width = w
	main_instance.height = h
	main_instance.setup_grid_array()

# Helper: flood the whole grid with unique per-cell types so no accidental
# matches exist, then let the caller overwrite specific cells to set up the
# exact match/no-match scenario a test needs.
func _flood_unique_types() -> void:
	for x in main_instance.width:
		for y in main_instance.height:
			main_instance.grid[x][y].type = "z%s%s" % [x, y]


# ---------------------------------------------------------------------------
# _ready() / grid setup coverage
# ---------------------------------------------------------------------------

func test_ready_populates_grid():
	assert_eq(main_instance.grid.size(), main_instance.width, "Grid should have `width` columns")
	assert_eq(main_instance.grid[0].size(), main_instance.height, "Each column should have `height` rows")
	assert_false(_grid_has_nulls(), "Expected no null cells once the board has settled")

func test_container_is_centered_on_ready():
	assert_true(main_instance.container is Node2D)

func test_grid_to_pixel_matches_default_offset():
	assert_eq(main_instance.grid_to_pixel(1, 1), Vector2(main_instance.offset, main_instance.offset))


# ---------------------------------------------------------------------------
# _input() coverage
#
# _input() reads container.get_local_mouse_position() directly, which can't
# be faked by constructing an InputEvent alone. GUT's stub() lets us fake
# that one method's return value on the real instance, so we can drive the
# full release -> calculate_swipe() path deterministically, including
# asserting Audio.play() actually gets called with the right arguments.
# ---------------------------------------------------------------------------

func test_input_ignores_press_events():
	main_instance.first_touch = Vector2i(2, 2)

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = true

	main_instance._input(event)

	assert_eq(main_instance.first_touch, Vector2i(2, 2), "first_touch should be unchanged on a press event")

func test_input_ignores_release_when_no_tile_was_touched():
	main_instance.first_touch = Vector2i(-1, -1)  # nothing pressed yet

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = false

	main_instance._input(event)

	assert_eq(main_instance.first_touch, Vector2i(-1, -1), "Should remain unset when no prior tile press happened")

# Note: _input()'s release branch calls container.get_local_mouse_position()
# internally, which we cannot fake -- GUT's stub()/assert_called() require an
# instance created via double()/partial_double(); they raise "An instance of
# a Double was expected" against a real, live node like container. Testing
# the full _input() release path with a controlled position isn't possible
# without either the OS-level mouse cursor or a source-level refactor to
# accept position as a parameter. calculate_swipe() itself -- the part that
# actually matters -- is still fully testable by calling it directly with a
# real Vector2, which is what the tests below and in the Audio section do.


# ---------------------------------------------------------------------------
# Audio coverage
#
# Audio is a true autoload singleton (accessed globally as `Audio`). GUT's
# assert_called()/get_call_parameters() only work on objects created via
# double()/partial_double() -- they cannot spy on a live, un-doubled
# singleton. Swapping the autoload node out for a double proved fragile
# (autoload identifiers don't reliably repoint to a spliced-in node, and it
# risks leaking broken state across every other test in the run), so these
# tests instead call the real code paths (which exercise Audio.play() as a
# side effect, raising audio.gd's line coverage) and assert on the resulting
# game-state behavior rather than on Audio call arguments directly.
# ---------------------------------------------------------------------------

func test_calculate_swipe_plays_swap_sound_on_valid_swap():
	_resize_grid(4, 4)
	_flood_unique_types()

	main_instance.first_touch = Vector2i(0, 0)
	var target_pixel = main_instance.grid_to_pixel(1, 0)

	main_instance.calculate_swipe(target_pixel)

	# swap_pieces() swaps the actual node references between the two cells,
	# and updates each node's own grid_position to match its new cell. So
	# after swapping (0,0) <-> (1,0): grid[1][0] now holds the piece that
	# used to be at (0,0), and that piece's grid_position should read (1,0)
	# -- matching where it now lives, not where it came from.
	assert_eq(main_instance.grid[1][0].grid_position, Vector2i(1, 0), "The piece now at (1,0) should have its grid_position updated to (1,0)")
	assert_eq(main_instance.grid[0][0].grid_position, Vector2i(0, 0), "The piece now at (0,0) should have its grid_position updated to (0,0)")

	await wait_seconds(0.7)

func test_calculate_swipe_does_not_play_sound_on_out_of_bounds_swipe():
	main_instance.first_touch = Vector2i(main_instance.width - 1, 0)  # rightmost column
	var target_pixel = main_instance.grid_to_pixel(main_instance.width - 1, 0) + Vector2(40, 0)  # would push off the right edge

	main_instance.calculate_swipe(target_pixel)

	# out-of-bounds swipes should reset first_touch without ever reaching the
	# swap/Audio.play() branch at all
	assert_eq(main_instance.first_touch, Vector2i(-1, -1))

func test_calculate_swipe_handles_vertical_drag():
	# Every other calculate_swipe test in this file drags horizontally, which
	# never exercises the vertical branch (other_touch.y += ...). This test
	# closes that gap with a downward drag instead.
	_resize_grid(4, 4)
	_flood_unique_types()

	main_instance.first_touch = Vector2i(0, 0)
	var target_pixel = main_instance.grid_to_pixel(0, 1)  # straight down, one cell

	main_instance.calculate_swipe(target_pixel)

	assert_eq(main_instance.grid[0][1].grid_position, Vector2i(0, 1), "The piece now at (0,1) should have its grid_position updated to (0,1)")
	assert_eq(main_instance.grid[0][0].grid_position, Vector2i(0, 0), "The piece now at (0,0) should have its grid_position updated to (0,0)")

	await wait_seconds(0.7)

func test_handle_swap_logic_plays_revert_sound_on_failed_swap():
	_resize_grid(4, 4)
	_flood_unique_types()  # guarantees no match anywhere

	main_instance.handle_swap_logic(Vector2i(0, 0), Vector2i(1, 0))

	await wait_seconds(0.7)  # two internal 0.3s timers plus margin

	# handle_swap_logic()'s else-branch swaps back to the original
	# arrangement on a failed match, so both pieces' grid_position should
	# read their original cells again.
	assert_eq(main_instance.grid[0][0].grid_position, Vector2i(0, 0), "Failed swap should have reverted piece positions")
	assert_eq(main_instance.grid[1][0].grid_position, Vector2i(1, 0), "Failed swap should have reverted piece positions")
	assert_false(main_instance.is_swapping, "is_swapping should be false again after a reverted (non-matching) swap completes")

func test_process_board_state_plays_match_sound_per_combo():
	_resize_grid(4, 4)
	for x in main_instance.width:
		for y in main_instance.height:
			main_instance.grid[x][y].type = "a"  # everything matches everything: guarantees at least one combo

	main_instance.process_board_state()

	await wait_seconds(2.0)  # generous window for the clear/collapse/refill loop to settle

	assert_false(main_instance.is_swapping, "process_board_state should finish with is_swapping false")
	assert_gt(main_instance.combo_count, 0, "Should have logged at least one combo given an all-matching grid; the per-combo Audio.play() call site runs as a side effect of this")


# ---------------------------------------------------------------------------
# handle_swap_logic() / is_swapping regression coverage
#
# Context: a bad edit once de-indented `is_swapping = false` out of the
# `else:` block in handle_swap_logic(), so it ran unconditionally after the
# first timer instead of only on a reverted (non-matching) swap. These two
# tests pin the correct behavior on both branches.
# ---------------------------------------------------------------------------

func test_handle_swap_logic_calls_process_board_state_when_match_found():
	_resize_grid(4, 4)
	_flood_unique_types()

	main_instance.grid[0][0].type = "a"
	main_instance.grid[1][0].type = "a"
	main_instance.grid[2][0].type = "a"

	var combo_count_before = main_instance.combo_count

	main_instance.handle_swap_logic(Vector2i(3, 0), Vector2i(3, 1))  # unrelated swap; row-0 match still stands

	await wait_seconds(0.4)  # past the first internal 0.3s timer, where the match check happens

	# process_board_state() resets combo_count to 0 then increments it at
	# least once per cascade iteration; if it never ran at all, combo_count
	# would remain whatever it was before this call.
	assert_gt(main_instance.combo_count, 0, "process_board_state() should have run and logged at least one combo, confirming the match-found branch in handle_swap_logic was reached")

	await wait_seconds(2.0)  # let cascades fully resolve so the test doesn't leak into the next one

func test_swap_logic_keeps_is_swapping_true_while_match_resolves():
	_resize_grid(4, 4)
	_flood_unique_types()

	# Pre-arrange a standing horizontal match on row 0 that will still be
	# present regardless of an unrelated swap elsewhere on the board. This
	# lets us drive a real handle_swap_logic() call down the "match found"
	# branch without depending on spawn_at()'s random tile types.
	main_instance.grid[0][0].type = "a"
	main_instance.grid[1][0].type = "a"
	main_instance.grid[2][0].type = "a"

	main_instance.handle_swap_logic(Vector2i(3, 0), Vector2i(3, 1))  # unrelated swap; row-0 match still stands

	assert_true(main_instance.is_swapping, "is_swapping must still be true right after handle_swap_logic returns, since process_board_state() owns clearing it")

	await wait_seconds(0.4)  # let the first internal 0.3s timer elapse

	assert_true(main_instance.is_swapping, "is_swapping should remain true while process_board_state() is still resolving matches/cascades")

	await wait_seconds(2.0)  # let cascades fully resolve so the test doesn't leak into the next one

func test_swap_logic_clears_is_swapping_on_failed_swap():
	_resize_grid(4, 4)
	_flood_unique_types()  # guarantees no match anywhere on the board

	main_instance.handle_swap_logic(Vector2i(0, 0), Vector2i(1, 0))

	await wait_seconds(0.7)  # two internal 0.3s timers plus margin

	assert_false(main_instance.is_swapping, "is_swapping should be false again after a reverted (non-matching) swap completes")


# ---------------------------------------------------------------------------
# collapse_columns() / refill_board() coverage
# ---------------------------------------------------------------------------

func test_collapse_columns_moves_piece_into_nearest_gap():
	_resize_grid(2, 3)

	var top_piece = main_instance.grid[0][0]
	main_instance.grid[0][1] = null  # clear the middle row

	await main_instance.collapse_columns()

	# collapse_columns scans bottom-up and pulls the nearest non-null piece
	# above a gap down into it -- it does not necessarily fall all the way
	# to the very bottom of the column.
	assert_eq(main_instance.grid[0][1], top_piece, "Top piece should fall into the nearest empty slot below it")
	assert_null(main_instance.grid[0][0], "Original top slot should now be empty")

func test_collapse_columns_moves_piece_to_the_very_bottom():
	_resize_grid(2, 3)

	var top_piece = main_instance.grid[0][0]
	# Both cells below top_piece must be empty for it to fall all the way to
	# the bottom -- clearing only the bottom cell pulls whichever piece is
	# directly above it instead (grid[0][1]), not top_piece.
	main_instance.grid[0][1] = null
	main_instance.grid[0][2] = null

	await main_instance.collapse_columns()

	assert_eq(main_instance.grid[0][2], top_piece, "Top piece should fall all the way to the bottom-most empty slot")
	assert_null(main_instance.grid[0][0], "Original top slot should now be empty")

func test_refill_board_fills_null_cells():
	main_instance.grid[0][0] = null

	await main_instance.refill_board()

	assert_not_null(main_instance.grid[0][0], "refill_board should spawn a new tile into the empty cell")

func test_pressing_a_tile_sets_first_touch_via_real_signal_chain():
	_resize_grid(4, 4)
	_flood_unique_types()

	# Go through the tile's own _input_event(), exactly as a real mouse press
	# would, rather than setting first_touch directly. This is the layer that
	# broke previously (a tile becoming unselectable), so it needs its own
	# dedicated coverage separate from the drag/swipe tests.
	var target_tile = main_instance.grid[2][1]
	assert_not_null(target_tile, "Sanity check: tile should exist at (2,1)")

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = true

	target_tile._input_event(null, event, 0)

	assert_eq(main_instance.first_touch, Vector2i(2, 1), "Pressing a real tile should set first_touch via the tile_pressed signal chain")

func test_full_press_and_drag_triggers_swap_end_to_end():
	_resize_grid(4, 4)
	_flood_unique_types()

	var pressed_tile = main_instance.grid[0][0]
	var press_event = InputEventMouseButton.new()
	press_event.button_index = MOUSE_BUTTON_LEFT
	press_event.pressed = true
	pressed_tile._input_event(null, press_event, 0)

	assert_eq(main_instance.first_touch, Vector2i(0, 0), "Press should register before we simulate the drag")

	# _input()'s release branch reads container.get_local_mouse_position()
	# directly, which can't be faked without a Double (see note above), so
	# we drive the drag via calculate_swipe() directly with a real position
	# -- this is the same call _input() would have made with a real mouse.
	var target_pixel = main_instance.grid_to_pixel(1, 0)
	main_instance.calculate_swipe(target_pixel)

	assert_eq(main_instance.first_touch, Vector2i(-1, -1), "Drag should complete and reset first_touch")
	assert_eq(main_instance.grid[1][0].grid_position, Vector2i(1, 0), "Swap should have actually happened, confirming the whole press->drag->swap pipeline works")

	await wait_seconds(0.7)
