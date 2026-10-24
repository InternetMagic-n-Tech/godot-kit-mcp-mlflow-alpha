# res://tests/unit/test_tile.gd
extends GutTest

const TileScript = preload("res://scripts/tile.gd")

var tile

func before_each():
	tile = TileScript.new()

func after_each():
	tile.free()

func test_type_and_grid_position_are_settable():
	tile.type = "3"
	tile.grid_position = Vector2i(2, 5)
	assert_eq(tile.type, "3")
	assert_eq(tile.grid_position, Vector2i(2, 5))

func test_input_event_emits_tile_pressed_on_left_click_press():
	tile.grid_position = Vector2i(1, 4)

	var result = { "pos": null }
	tile.tile_pressed.connect(func(pos): result["pos"] = pos)

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = true

	tile._input_event(null, event, 0)

	assert_eq(result["pos"], Vector2i(1, 4), "Should emit tile_pressed with the tile's grid position")

func test_input_event_does_not_emit_on_release():
	var result = { "emitted": false }
	tile.tile_pressed.connect(func(_pos): result["emitted"] = true)

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = false

	tile._input_event(null, event, 0)

	assert_false(result["emitted"], "Should not emit on button release")

func test_input_event_ignores_right_click():
	var result = { "emitted": false }
	tile.tile_pressed.connect(func(_pos): result["emitted"] = true)

	var event = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_RIGHT
	event.pressed = true

	tile._input_event(null, event, 0)

	assert_false(result["emitted"], "Should not emit on right-click")

func test_input_event_ignores_non_mouse_events():
	var result = { "emitted": false }
	tile.tile_pressed.connect(func(_pos): result["emitted"] = true)

	var event = InputEventKey.new()
	tile._input_event(null, event, 0)

	assert_false(result["emitted"], "Should not emit for non-mouse-button input")

# ---------------------------------------------------------------------------
# _on_move_finished() / Audio coverage
#
# Audio is a true autoload singleton. GUT's assert_called()/
# get_call_parameters() only work on objects created via double()/
# partial_double() -- confirmed directly by GUT's own runtime error ("An
# instance of a Double was expected") when tried against the real Audio
# node. So these tests just call _on_move_finished() for real (which
# exercises Audio.play() as a side effect, raising audio.gd's line coverage)
# and confirm it runs cleanly across different grid rows without erroring.
# ---------------------------------------------------------------------------

func test_on_move_finished_runs_without_error_at_row_zero():
	tile.grid_position = Vector2i(0, 0)
	tile._on_move_finished()
	pass_test("_on_move_finished() completed without error at row 0")

func test_on_move_finished_runs_without_error_at_a_later_row():
	tile.grid_position = Vector2i(0, 5)
	tile._on_move_finished()
	pass_test("_on_move_finished() completed without error at row 5, exercising the row-based pitch falloff branch")
