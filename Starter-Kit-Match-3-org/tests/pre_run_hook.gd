extends "res://addons/gut/hook_script.gd"

const Coverage = preload("res://addons/coverage/coverage.gd")
const exclude_paths = [
	"res://addons/*",
	"res://tests/*",
]

func run():
	Coverage.new(gut.get_tree(), exclude_paths)
	Coverage.instance.instrument_scripts("res://")
