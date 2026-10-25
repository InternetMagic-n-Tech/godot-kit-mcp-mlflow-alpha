# GDScript async rules
Calling an async function without `await` does not pause the caller.

```
func load_board():
	is_loading = true
	await _animate()
	is_loading = false

func start():
	load_board()				# not awaited: next line runs immediately
	is_loading = false	# BUG: fires before load_board finishes
```

Before moving or adding any flag reset (is_loading, is_animating), trace
every branch that sets that flag, including resets inside called functions.

# Godot Major Versions

If you are referencing any old code samples in godot they are likely not valid anymore.  Godot's type change in version v4 which is a big change from v3.  So be sure to understand the context of the code you writing.

# Godot Identation

Godot's GDScript (*.gd files) identing is important like Python.  As stated above the `await` (or lack thereof) can lead to side effects which is the same for removing indents off `if`/`elif`/`else`, loops (`for`/`while`/`case`-`switch`) statements and such.  If you reference any code samples using spaces be sure to switch to tabs when you write the files

# Godot Types

Godot's Type system is similar to pythons.  If you want to use an extended class and you want to use an extended child of that class as well; you'll declare a fuction with the extended class.  If you then want to use the extended classes methods/properties omitted from the base class you'll have to create a 'safe zone' to avoid compiler errors.

```
class_name BaseFooClass
...
class_name BaseBazClass extends BaseFooClass
...
func foo_baz_handler(obj: BaseFooClass):
	obj.bool_shared_prop = true
	obj.status_shared_prop = "queued"
	
	if obj is BaseBazClass:
		obj.bool_shared_prop = false
		obj.bool_baz_prop = true
		obj.status_shared_prop = "running"
		obj.begin_process()
	else:
		obj.queue_process()
```

# Godot lifecycle

- Order: _init, then _enter_tree, then children's _ready, then the
  parent's _ready. Children are ready before their parent.
- @onready vars are set just before _ready. Don't use them in _init.
- Calling an async function without `await` does not pause the caller.
  Code after the call runs immediately.
- queue_free() removes the node at the end of the frame. The node is
  still valid until then. Use is_instance_valid() before touching it
  after await.
- call_deferred() runs at the end of the current frame, after _process.
- Signals run connected callables synchronously, in connection order,
  when emitted.
