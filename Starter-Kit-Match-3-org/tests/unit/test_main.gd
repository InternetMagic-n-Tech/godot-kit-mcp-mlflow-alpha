# res://test/unit/test_main.gd
extends GutTest

const MainScript = preload("res://scripts/main.gd")

var main_scene

# Minimal stand-in for a real Tile node — find_matches() only reads
# .type and .grid_position, so this is all we need to fake a piece.
class FakePiece:
	var type: String
	var grid_position: Vector2i
	func _init(t, pos):
		type = t
		grid_position = pos

func before_each():
	main_scene = MainScript.new()
	main_scene.width = 4
	main_scene.height = 4

func after_each():
	main_scene.free()

func _build_grid(rows: Array) -> Array:
	# rows[y][x] = type string, or null for an empty cell
	var grid = []
	for x in main_scene.width:
		grid.append([])
		grid[x].resize(main_scene.height)
	for y in rows.size():
		for x in rows[y].size():
			var t = rows[y][x]
			grid[x][y] = null if t == null else FakePiece.new(t, Vector2i(x, y))
	return grid


func test_finds_horizontal_match_of_three():
	main_scene.grid = _build_grid([
		["a", "a", "a", "b"],
		["c", "d", "e", "f"],
		["b", "e", "d", "c"],
		["d", "f", "c", "e"],
	])
	var matches = main_scene.find_matches()
	assert_eq(matches.size(), 3, "Should find exactly 3 matched pieces")

func test_finds_vertical_match_of_three():
	main_scene.grid = _build_grid([
		["a", "c", "e", "g"],
		["a", "d", "f", "h"],
		["a", "e", "g", "b"],
		["b", "d", "f", "h"],
	])
	var matches = main_scene.find_matches()
	assert_eq(matches.size(), 3, "Should find exactly 3 matched pieces vertically")

func test_no_match_when_types_differ():
	main_scene.grid = _build_grid([
		["a", "b", "c", "d"],
		["b", "c", "d", "a"],
		["c", "d", "a", "b"],
		["d", "a", "b", "c"],
	])
	var matches = main_scene.find_matches()
	assert_eq(matches.size(), 0)

func test_is_within_grid_bounds():
	assert_true(main_scene.is_within_grid(Vector2i(0, 0)))
	assert_true(main_scene.is_within_grid(Vector2i(3, 3)))
	assert_false(main_scene.is_within_grid(Vector2i(-1, 0)))
	assert_false(main_scene.is_within_grid(Vector2i(4, 0)))

func test_grid_to_pixel_uses_offset():
	main_scene.offset = 68
	var pos = main_scene.grid_to_pixel(2, 3)
	assert_eq(pos, Vector2(136, 204))
