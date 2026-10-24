# res://tests/unit/test_audio.gd
extends GutTest

const AudioScript = preload("res://scripts/audio.gd")

var audio_instance

func before_each():
	audio_instance = AudioScript.new()

func after_each():
	audio_instance.free()

# linear_to_db()'s -80.0 floor branch is never reached through normal
# gameplay, since every Audio.play() call site in main.gd/tile.gd passes a
# positive volume literal. Calling it directly closes that gap.
func test_linear_to_db_floors_zero_volume_to_minus_80():
	assert_eq(audio_instance.linear_to_db(0.0), -80.0, "Zero linear volume should floor to -80db")

func test_linear_to_db_floors_negative_volume_to_minus_80():
	assert_eq(audio_instance.linear_to_db(-5.0), -80.0, "Negative linear volume should also floor to -80db")

func test_linear_to_db_converts_positive_volume():
	# 1.0 linear is defined as 0db in the standard log10-based conversion
	# audio.gd uses: 20 * log10(1.0) == 0.0
	assert_almost_eq(audio_instance.linear_to_db(1.0), 0.0, 0.001, "A linear volume of 1.0 should convert to 0db")
