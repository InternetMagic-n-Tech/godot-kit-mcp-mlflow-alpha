You can add this to help debugging if need be (remove when done)

```
@tool
extends Node

func find_index(arr: Array, predicate: Callable) -> int:
	for i in arr.size():
		if predicate.call(arr[i]):
			return i
	return -1

func find_indecies(arr: Array, predicate: Callable) -> Array[int]:
	var indecies: Array[int]
	for i in arr.size():
		if predicate.call(arr[i]):
			indecies.append(i)
	return indecies

func get_current_line_number(pos := 1) -> String:
	var stack = get_stack()
	if stack.size() > pos:
		# The first element [0] is the current frame
		return str(stack[pos]["line"])
	return "????" # Or handle the error as appropriate

func LNUM() -> String:
	return get_current_line_number(2)

func STMP(obj: Object) -> String:
	return obj.get_script() + " " + get_current_line_number(2)

func class_to_dict(obj: Object, is_skip_underscores := false) -> Dictionary[Variant, Variant]:
	var dict = {}
	for prop in obj.get_property_list():
		if not(prop.usage & PROPERTY_USAGE_SCRIPT_VARIABLE):
			continue
		if is_skip_underscores == true and prop.name[0] == "_":
			continue
		dict[prop.name] = obj.get(prop.name)

	if is_skip_underscores == true:
		dict["__SCRIPT__"] = obj.get_script()

	return dict

func class_to_file(obj: Object) -> String:
	if obj.get_script():
		return obj.get_script().resource_path.get_file()
	return ""
```
