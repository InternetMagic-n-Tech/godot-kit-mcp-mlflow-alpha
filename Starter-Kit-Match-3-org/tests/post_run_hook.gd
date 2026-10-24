extends "res://addons/gut/hook_script.gd"

const Coverage = preload("res://addons/coverage/coverage.gd")

const COVERAGE_TARGET := 0.0
const FILE_TARGET := 0.0

func run():
	var coverage = Coverage.instance
	coverage.set_coverage_targets(COVERAGE_TARGET, FILE_TARGET)
	coverage.save_coverage_file("res://coverage_report.json")
	Coverage.finalize(Coverage.Verbosity.FILENAMES)  # keep console output short
