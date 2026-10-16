# Class Nodes

Nodes for Class graphs: the event graphs and functions of Objects, Actors, components and every other class. Grouped as in **Add Node**.

## Events

| Node | Description |
| --- | --- |
| [Call Custom Event](call-custom-event.md) | Runs a custom event on a target object, then continues. |
| [Call Parent Event](call-parent-event.md) | Runs the parent class's version of an event that this graph overrides. |
| [Event Begin Play](event-begin-play.md) | Runs once when an actor or one of its components starts playing. |
| [Event Custom](event-custom.md) | Defines an event of your own that other graphs can call by name. |
| [Event Editor On Begin Play](event-editor-on-begin-play.md) | Runs when the editor loads an Editor Utility Object. |
| [Event On Actor Destroyed](event-on-actor-destroyed.md) | Runs when the actor this graph belongs to is destroyed. |
| [Event On Audio Finished](event-on-audio-finished.md) | Runs when an Audio component finishes playing a sound. |
| [Event On Begin Overlap](event-on-begin-overlap.md) | Runs when the actor's collider starts overlapping another actor, where one of the two is a trigger. |
| [Event On Checked Changed](event-on-checked-changed.md) | Runs when a checkbox, radio button or toggle changes its checked state. |
| [Event On Click](event-on-click.md) | Runs when a 2D Button is clicked or tapped. |
| [Event On Command Run](event-on-command-run.md) | Runs when the command it defines is entered in the console. |
| [Event On Editor Shutdown](event-on-editor-shutdown.md) | Runs when the project closes or its Editor Utility Objects are reloaded. |
| [Event On Editor Startup](event-on-editor-startup.md) | Runs when the editor starts the project's Editor Utility Objects. |
| [Event On End](event-on-end.md) | Runs once when the Game Instance or a subsystem shuts down. |
| [Event On End Overlap](event-on-end-overlap.md) | Runs when the actor's collider stops overlapping another actor it was overlapping. |
| [Event On First Scene Loaded](event-on-first-scene-loaded.md) | Runs once per session when the first scene has finished loading. |
| [Event On Focus Activate](event-on-focus-activate.md) | Runs when the focused 2D element is activated from the keyboard or gamepad. |
| [Event On Focus Enter](event-on-focus-enter.md) | Runs when a 2D element gains focus. |
| [Event On Focus Leave](event-on-focus-leave.md) | Runs when a 2D element loses focus. |
| [Event On Game Loaded](event-on-game-loaded.md) | Runs after Load Game restores saved world state and references, before gameplay continues. |
| [Event On Hit](event-on-hit.md) | Runs on each physics step that the actor's collider touches another solid collider. |
| [Event On Init](event-on-init.md) | Runs once when the Game Instance or a subsystem is created. |
| [Event On Mouse Enter](event-on-mouse-enter.md) | Runs when the pointer moves onto a 2D Button. |
| [Event On Mouse Leave](event-on-mouse-leave.md) | Runs when the pointer moves off a 2D Button. |
| [Event On Movement Jumped](event-on-movement-jumped.md) | Runs when the actor's Movement component starts a jump. |
| [Event On Movement Landed](event-on-movement-landed.md) | Runs when the actor's Movement component touches the ground after being airborne. |
| [Event On Movement Left Ground](event-on-movement-left-ground.md) | Runs when the actor's Movement component stops being on the ground. |
| [Event On Movement Started](event-on-movement-started.md) | Runs when the actor's Movement component starts moving horizontally. |
| [Event On Movement Stopped](event-on-movement-stopped.md) | Runs when the actor's Movement component stops moving horizontally. |
| [Event On Press End](event-on-press-end.md) | Runs when a press on a 2D Button ends. |
| [Event On Press Start](event-on-press-start.md) | Runs when a press begins on a 2D Button. |
| [Event On Range Changed](event-on-range-changed.md) | Runs when the lower or upper value of a 2D Range Slider changes. |
| [Event On Scene Actor Destroyed](event-on-scene-actor-destroyed.md) | Runs on a Scene Subsystem when an actor it saw spawn is destroyed. |
| [Event On Scene Actor Spawned](event-on-scene-actor-spawned.md) | Runs on a Scene Subsystem when an actor in the scene is about to begin play. |
| [Event On Scene Exit](event-on-scene-exit.md) | Runs when the current scene is removed, for a scene change or when Play ends. |
| [Event On Scene Finish Loading](event-on-scene-finish-loading.md) | Runs each time a scene has finished loading. |
| [Event On Scene Layer Actor Switched](event-on-scene-layer-actor-switched.md) | Runs on a Scene Layer Actor Switcher after it has changed the actor on display. |
| [Event On Scene Layer Actor Switched From](event-on-scene-layer-actor-switched-from.md) | Runs on a Scene Layer Actor when a switcher replaces it with another. |
| [Event On Scene Layer Actor Switched To](event-on-scene-layer-actor-switched-to.md) | Runs on a Scene Layer Actor when a switcher makes it the actor on display. |
| [Event On Scene Layer Actor Switching](event-on-scene-layer-actor-switching.md) | Runs on a Scene Layer Actor Switcher immediately before it changes the actor on display. |
| [Event On Scene Layer Added](event-on-scene-layer-added.md) | Runs on a Scene Subsystem when a Scene Layer is created while the subsystem exists. |
| [Event On Scene Layer Removed](event-on-scene-layer-removed.md) | Runs on a Scene Subsystem when a Scene Layer it saw added is removed. |
| [Event On Scene Loaded](event-on-scene-loaded.md) | Runs on a Scene Subsystem after its scene has finished loading. |
| [Event On Scene Open](event-on-scene-open.md) | Runs when a scene is opened in the editor. |
| [Event On Scene Saved](event-on-scene-saved.md) | Runs when a scene is saved in the editor. |
| [Event On Scene Start Loading](event-on-scene-start-loading.md) | Runs when the game begins loading a scene. |
| [Event On Selection Changed](event-on-selection-changed.md) | Runs when the selected option of a 2D Dropdown changes. |
| [Event On Streamed Scene Loaded](event-on-streamed-scene-loaded.md) | Runs on a Scene Subsystem when a streamed sub-scene becomes ready. |
| [Event On Streamed Scene Unloaded](event-on-streamed-scene-unloaded.md) | Runs on a Scene Subsystem when a streamed sub-scene is unloaded. |
| [Event On Text Changed](event-on-ui-text-changed.md) | Runs when the text in a 2D Text Input control changes. |
| [Event On Text Changed](event-on-text-changed.md) | Runs when the text of a text display component changes. |
| [Event On Text Submitted](event-on-text-submitted.md) | Runs when the player confirms the text in a 2D Text Input control. |
| [Event On Value Changed](event-on-value-changed.md) | Runs when the value of a slider, numeric input or progress bar changes. |
| [Event Save Migration](event-save-migration.md) | Updates a staged copy of an older save while Load Game runs. |
| [Event Scalability Changed](event-scalability-changed.md) | Runs when the renderer confirms or rejects the latest quality request. |
| [Event Tick](event-tick.md) | Runs on every simulation step, giving the time since the previous one. |

## Flow

| Node | Description |
| --- | --- |
| [Branch](branch.md) | Runs one of two paths depending on a condition. |
| [Break](break.md) | Leaves the loop it is inside and continues from that loop's Completed output. |
| [Do N](do-n.md) | Lets execution through up to N times, then blocks it until it is reset. |
| [Do Once](do-once.md) | Lets execution through the first time only, until it is reset. |
| [Entry](entry.md) | Starts an execution chain that no game event triggers. |
| [Flip Flop](flip-flop.md) | Alternates between two outputs each time it runs, starting with A. |
| [For Each](for-each.md) | Runs Loop Body once for every element of an array. |
| [For Each Map](for-each-map.md) | Runs Loop Body once for every key and value pair in a map. |
| [For Each Map With Break](for-each-map-with-break.md) | Runs Loop Body once for every key and value pair in a map, and can stop early. |
| [For Each With Break](for-each-with-break.md) | Runs Loop Body once for every element of an array, and can stop early. |
| [For Loop](for-loop.md) | Runs Loop Body once for each integer from First Index to Last Index. |
| [For Loop With Break](for-loop-with-break.md) | Runs Loop Body once for each integer from First Index to Last Index, and can stop early. |
| [Gate](gate.md) | Passes execution through only while the gate is open. |
| [Input](input.md) | Starts a function and provides the values its caller passed in. |
| [Output](output.md) | Returns values to the caller and ends the function. |
| [Sequence](sequence.md) | Runs its outputs one after another, from the first to the last. |
| [Switch on Int](switch-on-int.md) | Runs the output whose number matches an integer value, or Default if none match. |
| [Switch on String](switch-on-string.md) | Runs the output whose text matches a string value, or Default if none match. |
| [While Loop](while-loop.md) | Repeats Loop Body for as long as Condition is true. |

## Variables

| Node | Description |
| --- | --- |
| [Get Variable](get-variable.md) | Returns the current value of a variable. |
| [Set Variable](set-variable.md) | Sets a variable to a new value and passes that value on. |
| [Validated Get](validated-get.md) | Reads an object variable and runs **Is Valid** only if it holds an object. |

## Functions

| Node | Description |
| --- | --- |
| [Call Function](call-function.md) | Calls a function defined on a class and continues when it returns. |

## Interface

| Node | Description |
| --- | --- |
| [Call Interface Function](call-interface-function.md) | Calls a Script Interface method on another object and continues when it returns. |

## Casting

| Node | Description |
| --- | --- |
| [Cast To](cast-to.md) | Tests whether an object belongs to a class and returns it as that class if so. |
| [Float To Int](float-to-int.md) | Converts a Float to an Integer by dropping the fractional part. |
| [Int To Float](int-to-float.md) | Converts an Integer to a Float with the same value. |
| [Wildcard Is](wildcard-is.md) | Returns true when a value's type name matches the given tag. |
| [Wildcard To actorRef:Actor](wildcard-to-actorref-actor.md) | Converts an Any value to an Actor Reference and reports whether it worked. |
| [Wildcard To bool](wildcard-to-bool.md) | Converts an Any value to a Boolean and reports whether it worked. |
| [Wildcard To color](wildcard-to-color.md) | Converts an Any value to a Color and reports whether it worked. |
| [Wildcard To float](wildcard-to-float.md) | Converts an Any value to a Float and reports whether it worked. |
| [Wildcard To int](wildcard-to-int.md) | Converts an Any value to an Integer and reports whether it worked. |
| [Wildcard To objectRef:BObject](wildcard-to-objectref-bobject.md) | Converts an Any value to an Object Reference and reports whether it worked. |
| [Wildcard To quat](wildcard-to-quat.md) | Converts an Any value to a Quaternion and reports whether it worked. |
| [Wildcard To rotator](wildcard-to-rotator.md) | Converts an Any value to a Rotator and reports whether it worked. |
| [Wildcard To String](wildcard-to-string.md) | Converts any value to text and never fails. |
| [Wildcard To transform](wildcard-to-transform.md) | Converts an Any value to a Transform and reports whether it worked. |
| [Wildcard To vec2](wildcard-to-vec2.md) | Converts an Any value to a Vector 2 and reports whether it worked. |
| [Wildcard To vec3](wildcard-to-vec3.md) | Converts an Any value to a Vector 3 and reports whether it worked. |
| [Wildcard To vec4](wildcard-to-vec4.md) | Converts an Any value to a Vector 4 and reports whether it worked. |
| [Wildcard Type Of](wildcard-type-of.md) | Returns the name of the type a value holds, such as int or vec3. |

## Literal

| Node | Description |
| --- | --- |
| [Make Asset](make-asset.md) | Returns a reference to an asset that you pick on the node. |
| [Make Bool](make-bool.md) | Returns a Boolean value that you set on the node. |
| [Make Class](make-class.md) | Returns a class that you pick on the node. |
| [Make Float](make-float.md) | Returns a Float value that you set on the node. |
| [Make Int](make-int.md) | Returns an Integer value that you set on the node. |
| [Make Quaternion](make-quaternion-literal.md) | Returns a Quaternion value that you enter on the node. |
| [Make String](make-string.md) | Returns a String value that you set on the node. |
| [To String (Bool)](to-string-bool.md) | Converts a Boolean to the text true or false. |
| [To String (Color)](to-string-color.md) | Converts a Color to text that lists its four components. |
| [To String (Float)](to-string-float.md) | Converts a Float to its text form, such as 1.5. |
| [To String (Int)](to-string-int.md) | Converts an Integer to its text form, such as 42. |
| [To String (Rotator)](to-string-rotator.md) | Converts a Rotator to text that lists its pitch, roll and yaw. |
| [To String (Vector 2)](to-string-vector-2.md) | Converts a Vector 2 to text that lists its x and y values. |
| [To String (Vector 3)](to-string-vector-3.md) | Converts a Vector 3 to text that lists its x, y and z values. |
| [To String (Vector 4)](to-string-vector-4.md) | Converts a Vector 4 to text that lists its four values. |

## Math

| Node | Description |
| --- | --- |
| [Abs](abs.md) | Returns the input with any negative sign removed. |
| [Add](add.md) | Returns the sum of two values, component by component. |
| [Add Int](add-int.md) | Returns the sum of two whole numbers. |
| [Boolean And](boolean-and.md) | Returns true only when both inputs are true. |
| [Boolean Not](boolean-not.md) | Returns the opposite of the input: true becomes false and false becomes true. |
| [Boolean Or](boolean-or.md) | Returns true when at least one input is true. |
| [Ceil](ceil.md) | Rounds the input up to the nearest whole number. |
| [Clamp](clamp.md) | Limits a value so that it stays between a minimum and a maximum. |
| [Cos](cos.md) | Returns the cosine of an angle in radians. |
| [Degrees To Radians](degrees-to-radians.md) | Converts the input from degrees to radians. |
| [Divide](divide.md) | Returns the first number divided by the second. |
| [Divide Int](divide-int.md) | Returns the first whole number divided by the second, rounded toward zero. |
| [Equal](equal.md) | Returns true when two numbers are exactly equal. |
| [Floor](floor.md) | Rounds the input down to the nearest whole number. |
| [Greater or Equal](greater-or-equal.md) | Returns true when **A** is greater than or equal to **B**. |
| [Greater Than](greater-than.md) | Returns true when **A** is greater than **B**. |
| [Lerp](lerp.md) | Blends from one value to another by an amount between 0 and 1. |
| [Less or Equal](less-or-equal.md) | Returns true when **A** is less than or equal to **B**. |
| [Less Than](less-than.md) | Returns true when **A** is less than **B**. |
| [Max](max.md) | Returns the larger of two values, component by component. |
| [Min](min.md) | Returns the smaller of two values, component by component. |
| [Modulo](modulo.md) | Returns the remainder after dividing one Float by another. |
| [Modulo Int](modulo-int.md) | Returns the remainder after dividing one whole number by another. |
| [Multiply](multiply.md) | Returns the product of two numbers. |
| [Multiply Int](multiply-int.md) | Returns the product of two whole numbers. |
| [Nearly Equal](nearly-equal.md) | Returns true when two numbers differ by less than a very small amount. |
| [Negate](negate.md) | Flips the sign of the input. |
| [Not Equal](not-equal.md) | Returns true when two numbers are not exactly equal. |
| [Power](power.md) | Raises a base number to the power of an exponent. |
| [Radians To Degrees](radians-to-degrees.md) | Converts the input from radians to degrees. |
| [Random Bool](random-bool.md) | Returns true or false with equal chance. |
| [Random Float](random-float.md) | Returns a random number from 0 up to, but not including, 1. |
| [Random Int](random-int.md) | Returns a random whole number between **Min** and **Max**. |
| [Round](round.md) | Rounds the input to the nearest whole number. |
| [Sign](sign.md) | Returns -1, 0 or 1 depending on the sign of the input. |
| [Sin](sin.md) | Returns the sine of an angle in radians. |
| [Sqrt](sqrt.md) | Returns the square root of the input. |
| [Subtract](subtract.md) | Returns the first number minus the second. |
| [Subtract Int](subtract-int.md) | Returns the first whole number minus the second. |

## Vector

| Node | Description |
| --- | --- |
| [Add Vector2](add-vector2.md) | Returns the sum of two vectors, added component by component. |
| [Add Vector3](add-vector3.md) | Returns the sum of two vectors, added component by component. |
| [Add Vector4](add-vector4.md) | Returns the sum of two vectors, added component by component. |
| [Break Vector2](break-vector2.md) | Splits a Vector 2 into its X and Y numbers. |
| [Break Vector3](break-vector3.md) | Splits a Vector 3 into its X, Y and Z numbers. |
| [Break Vector4](break-vector4.md) | Splits a Vector 4 into its X, Y, Z and W numbers. |
| [Cross Vector3](cross-vector3.md) | Returns a vector perpendicular to both input vectors. |
| [Distance Vector2](distance-vector2.md) | Returns the distance between two points. |
| [Distance Vector3](distance-vector3.md) | Returns the distance between two points. |
| [Distance Vector4](distance-vector4.md) | Returns the distance between two Vector 4 values. |
| [Divide Vector2](divide-vector2.md) | Divides the first vector by the second, component by component. |
| [Divide Vector3](divide-vector3.md) | Divides the first vector by the second, component by component. |
| [Divide Vector4](divide-vector4.md) | Divides the first vector by the second, component by component. |
| [Dot Vector2](dot-vector2.md) | Returns the dot product of two vectors. |
| [Dot Vector3](dot-vector3.md) | Returns the dot product of two vectors. |
| [Dot Vector4](dot-vector4.md) | Returns the dot product of two vectors. |
| [Lerp Vector2](lerp-vector2.md) | Blends between two vectors using a factor from 0 to 1. |
| [Lerp Vector3](lerp-vector3.md) | Blends between two vectors using a factor from 0 to 1. |
| [Lerp Vector4](lerp-vector4.md) | Blends between two vectors using a factor from 0 to 1. |
| [Make Vector2](make-vector2.md) | Builds a Vector 2 from X and Y numbers. |
| [Make Vector3](make-vector3.md) | Builds a Vector 3 from X, Y and Z numbers. |
| [Make Vector4](make-vector4.md) | Builds a Vector 4 from X, Y, Z and W numbers. |
| [Multiply Vector2](multiply-vector2.md) | Multiplies two vectors together, component by component. |
| [Multiply Vector3](multiply-vector3.md) | Multiplies two vectors together, component by component. |
| [Multiply Vector4](multiply-vector4.md) | Multiplies two vectors together, component by component. |
| [Normalize Vector2](normalize-vector2.md) | Returns the vector scaled to a length of 1, keeping its direction. |
| [Normalize Vector3](normalize-vector3.md) | Returns the vector scaled to a length of 1, keeping its direction. |
| [Normalize Vector4](normalize-vector4.md) | Returns the vector scaled to a length of 1, keeping its direction. |
| [Scale Vector2](scale-vector2.md) | Multiplies every component of a vector by one number. |
| [Scale Vector3](scale-vector3.md) | Multiplies every component of a vector by one number. |
| [Scale Vector4](scale-vector4.md) | Multiplies every component of a vector by one number. |
| [Subtract Vector2](subtract-vector2.md) | Returns the first vector minus the second, component by component. |
| [Subtract Vector3](subtract-vector3.md) | Returns the first vector minus the second, component by component. |
| [Subtract Vector4](subtract-vector4.md) | Returns the first vector minus the second, component by component. |
| [Vector2 Length](vector2-length.md) | Returns the length of a vector. |
| [Vector2 Length Squared](vector2-length-squared.md) | Returns the length of a vector multiplied by itself. |
| [Vector3 Length](vector3-length.md) | Returns the length of a vector. |
| [Vector3 Length Squared](vector3-length-squared.md) | Returns the length of a vector multiplied by itself. |
| [Vector4 Length](vector4-length.md) | Returns the length of a vector. |
| [Vector4 Length Squared](vector4-length-squared.md) | Returns the length of a vector multiplied by itself. |

## Rotator

| Node | Description |
| --- | --- |
| [Break Rotator](break-rotator.md) | Splits a rotator into its pitch, yaw and roll angles in degrees. |
| [Combine Rotators](combine-rotators.md) | Combines two rotators into a single rotation. |
| [Delta Rotator](delta-rotator.md) | Returns the rotation that turns one rotator into another. |
| [Find Look At Rotation](find-look-at-rotation.md) | Returns the rotation that makes forward point from one location toward another. |
| [Get Forward Vector](get-forward-vector.md) | Returns the forward direction of a rotator as a unit vector. |
| [Get Right Vector](get-right-vector.md) | Returns the right direction of a rotator as a unit vector. |
| [Get Up Vector](get-up-vector.md) | Returns the up direction of a rotator as a unit vector. |
| [Inverse Rotator](inverse-rotator.md) | Returns the rotation that undoes a given rotator. |
| [Lerp Rotator](lerp-rotator.md) | Blends between two rotators along the shortest turn, using Alpha as the amount. |
| [Make Rotator](make-rotator.md) | Builds a rotator from pitch, yaw and roll angles in degrees. |
| [Rotator Nearly Equal](rotator-nearly-equal.md) | Returns true when two rotators are equal within a small tolerance. |

## Quaternion

| Node | Description |
| --- | --- |
| [Break Quaternion](break-quaternion.md) | Splits a quaternion into its X, Y, Z and W components. |
| [Inverse Quaternion](inverse-quaternion.md) | Returns the quaternion that undoes a rotation. |
| [Make Quaternion](make-quaternion.md) | Builds a quaternion from X, Y, Z and W components. |
| [Multiply Quaternion](multiply-quaternion.md) | Combines two quaternion rotations into one. |
| [Normalize Quaternion](normalize-quaternion.md) | Scales a quaternion to a length of 1 so it is a valid rotation. |
| [Quaternion To Rotator](quaternion-to-rotator.md) | Converts a quaternion into a rotator in degrees. |
| [Rotate Vector](rotate-vector.md) | Rotates a vector by a quaternion and returns the result. |
| [Rotator To Quaternion](rotator-to-quaternion.md) | Converts a rotator in degrees into a quaternion. |
| [Slerp Quaternion](slerp-quaternion.md) | Blends between two quaternions along the shortest path, using Alpha as the amount. |

## Transform

| Node | Description |
| --- | --- |
| [Add World Offset](add-world-offset.md) | Moves an actor by adding an offset to its current location. |
| [Break Transform](break-transform.md) | Splits a transform into its location, rotation and scale. |
| [Get Actor Forward Vector](get-actor-forward-vector.md) | Returns the direction an actor faces, as a unit vector along its forward axis. |
| [Get Actor Location](get-actor-location.md) | Returns an actor's location as a vector. |
| [Get Actor Right Vector](get-actor-right-vector.md) | Returns the direction to an actor's right, as a unit vector along its right axis. |
| [Get Actor Rotation](get-actor-rotation.md) | Returns an actor's rotation as a rotator in degrees. |
| [Get Actor Scale](get-actor-scale.md) | Returns an actor's scale on each axis as a vector. |
| [Get Actor Transform](get-actor-transform.md) | Returns an actor's location, rotation and scale as one transform. |
| [Get Actor Up Vector](get-actor-up-vector.md) | Returns the direction above an actor, as a unit vector along its up axis. |
| [Make Transform](make-transform.md) | Builds a transform from a location, a rotation and an optional scale. |
| [Set Actor Location](set-actor-location.md) | Moves an actor to a new location. |
| [Set Actor Rotation](set-actor-rotation.md) | Sets an actor's rotation from pitch, yaw and roll angles in degrees. |
| [Set Actor Scale](set-actor-scale.md) | Sets the scale of an actor on each axis. |
| [Set Actor Transform](set-actor-transform.md) | Sets an actor's location, rotation and scale from one transform. |

## Color

| Node | Description |
| --- | --- |
| [Break Color](break-color.md) | Splits a colour into its red, green, blue and alpha values. |
| [Color Nearly Equal](color-nearly-equal.md) | Returns true when two colours are equal within a small tolerance. |
| [Lerp Color](lerp-color.md) | Returns a colour blended between two colours, using Alpha as the mix amount. |
| [Make Color](make-color.md) | Builds a colour from red, green, blue and alpha values. |
| [Multiply Color](multiply-color.md) | Multiplies two colours channel by channel. |

## String

| Node | Description |
| --- | --- |
| [Concat](concat.md) | Joins two strings end to end, with A first and B second. |
| [Contains](contains.md) | Returns true when a string includes the search text anywhere. |
| [Ends With](ends-with.md) | Returns true when a string finishes with a given suffix. |
| [Equals](equals.md) | Returns true when two strings are exactly the same. |
| [Format String](format-string.md) | Builds text from a template, replacing each placeholder with a wired value. |
| [Join](join.md) | Combines an array of strings into one string with a separator between items. |
| [Length](length.md) | Returns the number of characters in a string. |
| [Parse Float](parse-float.md) | Converts text such as 3.5 into a Float and reports whether it worked. |
| [Parse Int](parse-int.md) | Converts text such as 42 into an Integer and reports whether it worked. |
| [Replace](replace.md) | Replaces every occurrence of the search text in a string with new text. |
| [Split](split.md) | Splits a string into an array of pieces at each separator. |
| [Starts With](starts-with.md) | Returns true when a string begins with a given prefix. |
| [Substring](substring.md) | Returns part of a string, from a start position up to an end position. |
| [To Lower](to-lower.md) | Converts every letter in a string to lower case. |
| [To Upper](to-upper.md) | Converts every letter in a string to upper case. |
| [Trim](trim.md) | Removes spaces and other whitespace from both ends of a string. |

## Array

| Node | Description |
| --- | --- |
| [Append Array](append-array.md) | Returns a copy of an array with the items of a second array added to the end. |
| [Append Item](append-item.md) | Returns a copy of an array with one item added to the end. |
| [Array Clear](array-clear.md) | Returns an empty array, leaving the input array unchanged. |
| [Array Contains](array-contains.md) | Returns true when an array holds an item equal to the given item. |
| [Array First](array-first.md) | Returns the first item of an array. |
| [Array Get](array-get.md) | Returns the item at an index, and whether that index exists. |
| [Array Insert](array-insert.md) | Returns a copy of an array with an item inserted at an index. |
| [Array Last](array-last.md) | Returns the last item of an array. |
| [Array Length](array-length.md) | Returns how many items an array holds. |
| [Array Reverse](array-reverse.md) | Returns a copy of an array with its items in reverse order. |
| [Array Slice](array-slice.md) | Returns a new array holding the items from a start index up to an end index. |
| [Find Index](find-index.md) | Returns the index of the first item equal to the given item. |
| [Is Empty](array-is-empty.md) | Returns true when an array has no items. |
| [Is Valid Index](is-valid-index.md) | Returns true when an index points at an item in an array. |
| [Last Index](last-index.md) | Returns the index of the last item in an array. |
| [Make Array](make-array.md) | Builds an array from the item inputs you add. |
| [Remove At](remove-at.md) | Returns a copy of an array with the item at an index removed. |
| [Remove Item](remove-item.md) | Returns a copy of an array with the first matching item removed. |
| [Set At Index](set-at-index.md) | Returns a copy of an array with the item at an index replaced. |

## Map

| Node | Description |
| --- | --- |
| [Break Map](break-map.md) | Splits a map into an array of keys and an array of values. |
| [Is Empty](map-is-empty.md) | Returns true when a map has no entries. |
| [Make Map](make-map.md) | Builds a map from key and value pairs. |
| [Map Clear](map-clear.md) | Returns an empty map, leaving the input map unchanged. |
| [Map Get](map-get.md) | Returns the value stored for a key, and whether the key exists. |
| [Map Has](map-has.md) | Returns true when a map contains a key. |
| [Map Keys](map-keys.md) | Returns all keys of a map as an array. |
| [Map Remove](map-remove.md) | Returns a copy of a map without the given key. |
| [Map Set](map-set.md) | Returns a copy of a map with a key set to a value. |
| [Map Size](map-size.md) | Returns how many key and value pairs a map holds. |
| [Map Values](map-values.md) | Returns all values of a map as an array. |

## Select

| Node | Description |
| --- | --- |
| [Select Bool](select-bool.md) | Returns one of two Boolean values, chosen by a Boolean condition. |
| [Select Color](select-color.md) | Returns one of two Color values, chosen by a Boolean condition. |
| [Select Float](select-float.md) | Returns one of two Float values, chosen by a Boolean condition. |
| [Select Int](select-int.md) | Returns one of two Integer values, chosen by a Boolean condition. |
| [Select Rotator](select-rotator.md) | Returns one of two Rotator values, chosen by a Boolean condition. |
| [Select String](select-string.md) | Returns one of two String values, chosen by a Boolean condition. |
| [Select Tag](select-tag.md) | Returns one of two Tag values, chosen by a Boolean condition. |
| [Select TagContainer](select-tagcontainer.md) | Returns one of two TagContainer values, chosen by a Boolean condition. |
| [Select Transform](select-transform.md) | Returns one of two Transform values, chosen by a Boolean condition. |
| [Select Vector 2](select-vector-2.md) | Returns one of two Vector 2 values, chosen by a Boolean condition. |
| [Select Vector 3](select-vector-3.md) | Returns one of two Vector 3 values, chosen by a Boolean condition. |
| [Select Vector 4](select-vector-4.md) | Returns one of two Vector 4 values, chosen by a Boolean condition. |

## Enum

| Node | Description |
| --- | --- |
| [Enum to String](enum-to-string.md) | Returns the name of an enum member as text. |
| [Equal Enum](equal-enum.md) | Returns true when two enum values are the same member. |
| [Make Enum](make-enum.md) | Returns a member of an enum that you choose on the node. |
| [Not Equal Enum](not-equal-enum.md) | Returns true when two enum values are different members. |
| [Select](select.md) | Returns the value wired to the option that matches an enum member. |
| [Switch on Enum](switch-on-enum.md) | Runs one execution path depending on which enum member a value holds. |

## Struct

| Node | Description |
| --- | --- |
| [Break Structure](break-structure.md) | Splits a structure value into its individual fields. |
| [Make Structure](make-structure.md) | Builds a structure value from its fields. |

## Tags

| Node | Description |
| --- | --- |
| [Add Tag](add-tag.md) | Returns a new TagContainer with a Tag added. |
| [Assign Tag](assign-tag.md) | Assigns a Tag to a variable and returns the assigned Tag. |
| [Assign TagContainer](assign-tagcontainer.md) | Assigns a TagContainer to a variable and returns the assigned TagContainer. |
| [Clear TagContainer](clear-tagcontainer.md) | Returns a new, empty TagContainer, whatever the input holds. |
| [Difference Tags](difference-tags.md) | Returns a TagContainer with the Tags from the first that are not in the second. |
| [Equal Tag](equal-tag.md) | Returns true when two Tags are the same Tag. |
| [Equal TagContainer](equal-tagcontainer.md) | Returns true when two TagContainers hold exactly the same Tags. |
| [Get Tags](get-tags.md) | Returns the Tags held in a TagContainer as an array. |
| [Has All Tags](has-all-tags.md) | Returns true when a TagContainer matches every Tag in a second TagContainer. |
| [Has Any Tags](has-any-tags.md) | Returns true when a TagContainer matches at least one Tag in a second TagContainer. |
| [Has Tag](has-tag.md) | Returns true when a TagContainer holds a Tag, or a child of that Tag. |
| [Intersect Tags](intersect-tags.md) | Returns a TagContainer with only the Tags found in both TagContainers. |
| [Is TagContainer Empty](is-tagcontainer-empty.md) | Returns true when a TagContainer holds no Tags. |
| [Is Valid Tag](is-valid-tag.md) | Returns true when a Tag exists in the project's Tags. |
| [Make Tag](make-tag.md) | Returns a Tag chosen from the project's Tags. |
| [Make TagContainer](make-tagcontainer.md) | Returns a TagContainer holding the Tags you select. |
| [Make TagContainer From Array](make-tagcontainer-from-array.md) | Returns a TagContainer built from an array of Tags. |
| [Matches Tag](matches-tag.md) | Returns true when a Tag is the same as, or a child of, a query Tag. |
| [Not Equal Tag](not-equal-tag.md) | Returns true when two Tags are different Tags. |
| [Remove Tag](remove-tag.md) | Returns a new TagContainer without a given Tag. |
| [Select By Tag](select-by-tag.md) | Returns the value that belongs to the case matching a Tag. |
| [Switch On Tag](switch-on-tag.md) | Runs the output for the case that matches a Tag. |
| [Tag Count](tag-count.md) | Returns how many Tags a TagContainer holds. |
| [Tag To String](tag-to-string.md) | Returns the full dotted path of a Tag as text. |
| [Union Tags](union-tags.md) | Returns a TagContainer with every Tag from either of two TagContainers. |

## Data

| Node | Description |
| --- | --- |
| [Get Data Children](get-data-children.md) | Returns the paths of an entry's immediate children, in sibling order. |
| [Get Data Descendants](get-data-descendants.md) | Returns the paths of every entry below an entry, with parents listed before their children. |
| [Get Data Parent](get-data-parent.md) | Returns the path of an entry's parent. |
| [Read Data Entry](read-data-entry.md) | Reads an entry's values from a Data Tree that is already loaded and returns a copy. |
| [Read Data Entry Async](read-data-entry-async.md) | Loads a Data Tree and its Data Definition in the background, then reads one entry from it. |

## Actor

| Node | Description |
| --- | --- |
| [Attach Actor](attach-actor.md) | Makes an actor a child of another actor so it follows its parent. |
| [Attach To Bone](attach-to-bone.md) | Attaches an actor to a named bone of another actor's model so it follows that bone. |
| [Destroy Actor](destroy-actor.md) | Removes an actor, and all of its components, from the game. |
| [Detach Actor](detach-actor.md) | Removes an actor's parent so it no longer follows another actor. |
| [Get Actor Name](get-actor-name.md) | Returns the name of an actor as text. |
| [Get Actor Of Class](get-actor-of-class.md) | Returns one actor of a Class, or an empty reference when none exists. |
| [Get All Actors Of Class](get-all-actors-of-class.md) | Returns every actor in the game that is an instance of a Class. |
| [Get Owner](get-owner.md) | Returns the actor that owns another actor. |
| [Get Parent](get-parent.md) | Returns the actor that another actor is attached to. |
| [Get Self](get-self.md) | Returns a reference to the actor that is running this graph. |
| [Is Valid](is-valid.md) | Returns true when an object reference points to an object, and false when it is empty. |
| [Set Owner](set-owner.md) | Records an actor as the owner of another actor, without attaching or moving it. |
| [Spawn Actor](spawn-actor.md) | Creates a new actor from a Class and returns a reference to it. |

## Component

| Node | Description |
| --- | --- |
| [Add Component](add-component.md) | Adds a new component of a chosen type to an actor and returns it. |
| [Get All Components Of Type](get-all-components-of-type.md) | Returns every component of a type across all actors in the game. |
| [Get Component](get-component.md) | Returns the component of a given type on one actor. |
| [Get Component Ref](get-component-ref.md) | Returns a component of an actor as a typed reference. |
| [Get First Component Of Type](get-first-component-of-type.md) | Returns the first component of a type found on any actor in the game. |
| [Has Component](has-component.md) | Returns true when an actor has a component of a given type. |

## Camera

| Node | Description |
| --- | --- |
| [Get Field Of View](get-field-of-view.md) | Returns a camera's field of view in degrees. |
| [Get Orthographic Size](get-orthographic-size.md) | Returns half the height of an orthographic camera's view, in world units. |
| [Possess Camera](possess-camera.md) | Makes the camera on an actor the view the player sees. |
| [Set Field Of View](set-field-of-view.md) | Sets a camera's field of view in degrees. |
| [Set Orthographic Size](set-orthographic-size.md) | Sets half the height of an orthographic camera's view, in world units. |

## Light

| Node | Description |
| --- | --- |
| [Set Light Color](set-light-color.md) | Sets the colour of a light. |
| [Set Light Enabled](set-light-enabled.md) | Turns a light on or off. |
| [Set Light Intensity](set-light-intensity.md) | Sets how bright a light is. |

## Physics

| Node | Description |
| --- | --- |
| [Add Impulse](add-impulse.md) | Applies an instant push to an actor's dynamic Rigid Body. |
| [Line Trace](line-trace.md) | Casts a ray from a start point to an end point and reports the first thing it hits. |
| [Move Character](move-character.md) | Moves an actor by a distance, sliding along solid colliders instead of passing through them. |
| [Sample Water Surface](sample-water-surface.md) | Samples the rendered water surface at a world position, including wave motion. |
| [Sphere Overlap Actors](sphere-overlap-actors.md) | Returns the actors whose colliders overlap a sphere at a given point. |
| [Sphere Shape Sweep](sphere-shape-sweep.md) | Sweeps a sphere from a start point to an end point and reports the first hit. |

## Input

| Node | Description |
| --- | --- |
| [Add Input Action Binding](add-input-action-binding.md) | Adds a key binding to an Input Action while the game runs. |
| [Add Input Axis Binding](add-input-axis-binding.md) | Adds a key binding to an Input Axis while the game runs. |
| [Event Input Action](event-input-action.md) | Runs when a chosen Input Action starts, stays held or is released. |
| [Event Input Axis](event-input-axis.md) | Runs when a chosen Input Axis moves away from zero, stays active or returns to zero. |
| [Export Input Bindings](export-input-bindings.md) | Returns the player's binding changes as text that can be saved. |
| [Get Cursor Position](get-cursor-position.md) | Returns the pointer position over the game view. |
| [Get Input Bindings](get-input-bindings.md) | Returns the current bindings of an Input Action or Input Axis. |
| [Hide Cursor](hide-cursor.md) | Hides the mouse pointer over the game view. |
| [Import Input Bindings](import-input-bindings.md) | Applies binding changes exported earlier, replacing the current changes. |
| [On Any Key Pressed](on-any-key-pressed.md) | Runs for each key, mouse button or gamepad control that is newly pressed. |
| [On Gamepad Connected](on-gamepad-connected.md) | Runs when a gamepad connects, with its index. |
| [On Gamepad Disconnected](on-gamepad-disconnected.md) | Runs when a gamepad disconnects, with its index. |
| [Project Cursor To Scene](project-cursor-to-scene.md) | Casts a ray from the active camera through the cursor and returns what it hits. |
| [Remove Input Action Binding](remove-input-action-binding.md) | Removes every binding of a key from an Input Action. |
| [Remove Input Axis Binding](remove-input-axis-binding.md) | Removes every binding of a key from an Input Axis. |
| [Reset All Input Bindings](reset-all-input-bindings.md) | Removes all player binding changes and restores every authored binding. |
| [Reset Input Bindings](reset-input-bindings.md) | Restores one Input Action or Input Axis to its authored bindings. |
| [Set Gamepad Rumble](set-gamepad-rumble.md) | Vibrates a gamepad for a set time. |
| [Set Input Action Binding](set-input-action-binding.md) | Changes the key of an existing Input Action binding. |
| [Set Input Axis Binding](set-input-axis-binding.md) | Changes the key of an existing Input Axis binding. |
| [Show Cursor](show-cursor.md) | Shows the mouse pointer over the game view. |

## Audio

| Node | Description |
| --- | --- |
| [Play Sound](play-sound.md) | Plays an Audio asset, positioned at the actor running the graph when the sound is spatial. |
| [Set Channel Volume](set-channel-volume.md) | Sets the volume of an Audio Channel for the current session. |
| [Set Global Volume](set-global-volume.md) | Sets the master volume of the selected Audio Mixer for the current session. |

## Particles

| Node | Description |
| --- | --- |
| [Play Particles](play-particles.md) | Starts the particle systems on an actor. |
| [Stop Particles](stop-particles.md) | Stops the particle systems on an actor from emitting. |

## Animation

| Node | Description |
| --- | --- |
| [Get Anim Graph Variable](get-anim-graph-variable.md) | Returns the value of a variable on an Animation Graph component. |
| [Get Current State](get-current-state.md) | Returns the name and ID of the state an Animation Graph is in. |
| [Jump To State](jump-to-state.md) | Switches an Animation Graph to a named state, skipping its transitions. |
| [Set Anim Graph Variable](set-anim-graph-variable.md) | Sets a variable on an Animation Graph component. |

## Behaviour Tree

| Node | Description |
| --- | --- |
| [Finish Execute](finish-execute.md) | Ends the running task and reports success or failure to the Behaviour Tree. |
| [Get Blackboard](get-blackboard.md) | Returns the value stored under a key in the tree's Blackboard. |
| [On Abort](on-abort.md) | Runs when the Behaviour Tree stops this task before it finishes. |
| [On Activate](on-activate.md) | Runs once when the Behaviour Tree starts this task. |
| [On Evaluate](on-evaluate.md) | Runs when the Behaviour Tree checks this decorator's condition. |
| [On Tick](on-tick.md) | Runs every update while a task is active, or at each interval for a service. |
| [Return Condition](return-condition.md) | Sets whether a decorator allows its branch to run. |
| [Set Blackboard](set-blackboard.md) | Stores a value under a key in the tree's Blackboard. |

## Navigation

| Node | Description |
| --- | --- |
| [Add Obstacle](add-obstacle.md) | Blocks part of the navigation mesh with an unwalkable box or cylinder. |
| [Find Path To](find-path-to.md) | Finds a walkable route between two points on the navigation mesh. |
| [Get Closest Navigable Point](get-closest-navigable-point.md) | Finds the point on the navigation mesh nearest to a position. |
| [Get Random Point In Radius](get-random-point-in-radius.md) | Picks a random walkable point within a radius of a position. |
| [Is Path Valid](is-path-valid.md) | Checks whether a walkable route exists between two points. |
| [Move To](move-to.md) | Sends an actor toward a destination along the navigation mesh. |
| [Remove Obstacle](remove-obstacle.md) | Removes an obstacle that Add Obstacle placed, making the area walkable again. |
| [Stop Movement](stop-movement.md) | Stops an actor that is walking along a navigation path. |

## Scene

| Node | Description |
| --- | --- |
| [Change Scene](change-scene.md) | Leaves the current Scene and loads another one. |
| [Get Scene Load Progress](get-scene-load-progress.md) | Returns how far a streamed Scene has loaded, from 0 to 1. |
| [Get Scene State](get-scene-state.md) | Returns whether a streamed Scene is unloaded, loading, loaded or unloading. |
| [Get Target Scene Name](get-target-scene-name.md) | Returns the name of the Scene that a Scene Streaming Actor loads. |
| [Is Scene Loaded](is-scene-loaded.md) | Returns true once all actors and render resources of a streamed Scene are ready. |
| [Load Scene Async](load-scene-async.md) | Starts loading a Scene Streaming Actor's Scene while the game keeps running. |
| [Load Scene Blocking](load-scene-blocking.md) | Loads a Scene Streaming Actor's Scene and waits until it is ready, pausing the game. |
| [Unload Scene Async](unload-scene-async.md) | Starts unloading a Scene Streaming Actor's Scene while the game keeps running. |
| [Unload Scene Blocking](unload-scene-blocking.md) | Unloads a Scene Streaming Actor's Scene and waits until it is gone, pausing the game. |

## Scene Layer

| Node | Description |
| --- | --- |
| [Clear Scene Layer](clear-scene-layer.md) | Removes every Scene Layer and all of their actors. |
| [Create Scene Layer](create-scene-layer.md) | Creates a Scene Layer from an asset and waits until it is ready. |
| [Register Scene Layer Post-Processing](register-scene-layer-post-processing.md) | Adds a post-process Material to the effects applied to a Scene Layer. |
| [Remove Scene Layer](remove-scene-layer.md) | Removes a Scene Layer and all of its actors. |
| [Unregister Scene Layer Post-Processing](unregister-scene-layer-post-processing.md) | Removes a post-process Material from the effects applied to a Scene Layer. |

## Render

| Node | Description |
| --- | --- |
| [Capture Render Target](capture-render-target.md) | Requests one capture from a Render Target Capture actor. |
| [Get Capture Actors](get-capture-actors.md) | Returns the list of actors that a capture is limited to. |
| [Get Capture Enabled](get-capture-enabled.md) | Returns whether a Render Target Capture actor is allowed to capture. |
| [Get Capture Every Frame](get-capture-every-frame.md) | Returns whether a Render Target Capture actor updates every frame. |
| [Get Capture Far Clip](get-capture-far-clip.md) | Returns the far clip distance of a capture actor's camera. |
| [Get Capture Field Of View](get-capture-field-of-view.md) | Returns the field of view of a capture actor's camera, in degrees. |
| [Get Capture Near Clip](get-capture-near-clip.md) | Returns the near clip distance of a capture actor's camera. |
| [Get Capture Only Actors](get-capture-only-actors.md) | Returns whether a capture draws only the actors in its list. |
| [Get Capture Render Target](get-capture-render-target.md) | Returns the Render Target that a Render Target Capture actor draws into. |
| [Get Render Target Mode](get-render-target-mode.md) | Returns what a Render Target records: Scene Color, Depth Pass or World Normal. |
| [Get Texture Render Target](get-texture-render-target.md) | Returns the Render Target that a Render Target Texture displays. |
| [Set Capture Actors](set-capture-actors.md) | Sets the list of actors that a capture is limited to. |
| [Set Capture Enabled](set-capture-enabled.md) | Turns a Render Target Capture actor on or off. |
| [Set Capture Every Frame](set-capture-every-frame.md) | Sets whether a Render Target Capture actor updates every frame. |
| [Set Capture Far Clip](set-capture-far-clip.md) | Sets the far clip distance of a capture actor's camera. |
| [Set Capture Field Of View](set-capture-field-of-view.md) | Sets the field of view of a capture actor's camera, in degrees. |
| [Set Capture Near Clip](set-capture-near-clip.md) | Sets the near clip distance of a capture actor's camera. |
| [Set Capture Only Actors](set-capture-only-actors.md) | Sets whether a capture draws only the actors in its list. |
| [Set Capture Render Target](set-capture-render-target.md) | Changes the Render Target that a Render Target Capture actor draws into. |

## Scalability

| Node | Description |
| --- | --- |
| [Get Effective Scalability](get-effective-scalability.md) | Returns the quality settings you requested and the ones the renderer is using. |
| [Reset to Project Defaults](reset-to-project-defaults.md) | Clears all temporary quality and rendering changes made during this session. |
| [Set Antialiasing](set-antialiasing.md) | Turns FXAA antialiasing on or off for the current session. |
| [Set CEL Outlines](set-cel-outlines.md) | Turns global CEL outlines on or off and sets their colour and width. |
| [Set CEL Shading](set-cel-shading.md) | Changes CEL banding, specular highlights, light mixing and outlines. |
| [Set Environment Lighting](set-environment-lighting.md) | Changes image-based lighting: whether it is on, its intensity, rotation and CEL strength. |
| [Set Frame Cap](set-frame-cap.md) | Limits how many frames per second the game presents. |
| [Set Geometry Quality](set-geometry-quality.md) | Turns automatic Model level of detail on or off and scales when simpler levels take over. |
| [Set Lighting Quality](set-lighting-quality.md) | Chooses automatic or manual limits on how many local lights are drawn. |
| [Set Post Processing Quality](set-post-processing-quality.md) | Scales the resolution of post-process passes that allow scalable resolution. |
| [Set Render Mode](set-render-mode.md) | Switches between PBR and CEL rendering for the current session. |
| [Set Render Path](set-render-path.md) | Requests the render path: Auto, Forward or Clustered Forward. |
| [Set Render Resolution](set-render-resolution.md) | Locks the rendered output to a fixed width and height, with black bars if needed. |
| [Set Render Scale](set-render-scale.md) | Sets a fixed render scale and turns off dynamic resolution. |
| [Set Rendering Effects](set-rendering-effects.md) | Sets the colour pipeline, tone mapping, exposure, bloom, vignette and FXAA. |
| [Set Resolution Quality](set-resolution-quality.md) | Sets render scale, dynamic resolution limits and the target frame rate. |
| [Set Scalability Preset](set-scalability-preset.md) | Applies a Low, Medium, High or Ultra quality tier to the current session. |
| [Set Shadow Quality](set-shadow-quality.md) | Sets shadow map size, filtering, distance and the limits for local-light shadows. |
| [Set Shadows Enabled](set-shadows-enabled.md) | Turns shadows on or off for the current session without losing their settings. |
| [Set Texture Quality](set-texture-quality.md) | Sets texture detail bias, anisotropic filtering and the texture memory budget. |
| [Set Vignette Color](set-vignette-color.md) | Sets the vignette tint colour for the current session. |
| [Set Water Quality](set-water-quality.md) | Caps the rendering cost of water, including shading, mesh density, reflections and wave detail. |

## Material

| Node | Description |
| --- | --- |
| [Get Material Asset](get-material-asset.md) | Returns the Material or Material Instance asset that a Material Object renders. |
| [Get Material Color Parameter](get-material-color-parameter.md) | Returns the current value of a named Color parameter on a Material Object. |
| [Get Material Float Parameter](get-material-float-parameter.md) | Returns the current value of a named Float parameter on a Material Object. |
| [Get Material Texture Parameter](get-material-texture-parameter.md) | Returns the Texture assigned to a named Texture parameter on a Material Object. |
| [Get Post Process Entry](get-post-process-entry.md) | Returns the Material Object of one post-process pass on a Scene or Scene Layer. |
| [Reset Material Color Parameter](reset-material-color-parameter.md) | Restores a Color parameter on a Material Object to its original value. |
| [Reset Material Float Parameter](reset-material-float-parameter.md) | Restores a Float parameter on a Material Object to its original value. |
| [Reset Material Texture Parameter](reset-material-texture-parameter.md) | Restores a Texture parameter on a Material Object to its original Texture. |
| [Set Material Color Parameter](set-material-color-parameter.md) | Sets a named Color parameter on a Material Object. |
| [Set Material Float Parameter](set-material-float-parameter.md) | Sets a named Float parameter on a Material Object. |
| [Set Material Instance](set-material-instance.md) | Assigns a Material Instance to a mesh component and returns its Material Object. |
| [Set Material Texture Parameter](set-material-texture-parameter.md) | Sets a named Texture parameter on a Material Object, loading the Texture first. |

## Timers

| Node | Description |
| --- | --- |
| [Delay](delay.md) | Waits for a number of seconds, then continues. |

## Tween

| Node | Description |
| --- | --- |
| [Tween 2D Opacity](tween-2d-opacity.md) | Fades the opacity of a 2D component from A to B over Duration seconds. |
| [Tween 2D Tint](tween-2d-tint.md) | Blends the tint colour of a 2D component from A to B over Duration seconds. |
| [Tween Actor Position](tween-actor-position.md) | Moves an actor from position A to position B over Duration seconds. |
| [Tween Actor Rotation](tween-actor-rotation.md) | Rotates an actor from rotation A to rotation B over Duration seconds. |
| [Tween Actor Scale](tween-actor-scale.md) | Scales an actor from scale A to scale B over Duration seconds. |
| [Tween Actor Transform](tween-actor-transform.md) | Moves, rotates and scales an actor from Transform A to Transform B together. |
| [Tween Anchor Offset](tween-anchor-offset.md) | Moves a 2D Anchor component's offset from A to B over Duration seconds. |
| [Tween Color](tween-color.md) | Animates a Color variable from A to B, blending every colour channel. |
| [Tween Component Position](tween-component-position.md) | Moves a component from position A to position B over Duration seconds. |
| [Tween Component Rotation](tween-component-rotation.md) | Rotates a component from rotation A to rotation B over Duration seconds. |
| [Tween Component Scale](tween-component-scale.md) | Scales a component from scale A to scale B over Duration seconds. |
| [Tween Component Transform](tween-component-transform.md) | Moves, rotates and scales a component from Transform A to Transform B together. |
| [Tween Float](tween-float.md) | Animates a Float variable from A to B over Duration seconds. |
| [Tween Integer](tween-integer.md) | Animates an Integer variable from A to B in whole-number steps. |
| [Tween Layout Size](tween-layout-size.md) | Resizes a 2D layout component from size A to size B over Duration seconds. |
| [Tween Quaternion](tween-quaternion.md) | Animates a Quaternion variable from A to B along the shortest rotation. |
| [Tween Rotator](tween-rotator.md) | Animates a Rotator variable from A to B by blending pitch, yaw and roll. |
| [Tween Scroll Offset](tween-scroll-offset.md) | Scrolls a 2D Scroll Box from offset A to offset B over Duration seconds. |
| [Tween Text Color](tween-text-color.md) | Blends the text colour of a 2D text component from A to B over Duration seconds. |
| [Tween Text Font Size](tween-text-font-size.md) | Changes the font size of a 2D text component from A to B over Duration seconds. |
| [Tween Text Outline](tween-text-outline.md) | Changes the outline width of a 2D text component from A to B over Duration seconds. |
| [Tween Text Outline Color](tween-text-outline-color.md) | Blends the outline colour of a 2D text component from A to B over Duration seconds. |
| [Tween Text Wrap Size](tween-text-wrap-size.md) | Changes the wrap width and height of a 2D text component from A to B over Duration seconds. |
| [Tween Transform](tween-transform.md) | Animates a Transform variable from A to B, blending location, rotation and scale. |
| [Tween Vector2](tween-vector2.md) | Animates a Vector 2 variable from A to B over Duration seconds. |
| [Tween Vector3](tween-vector3.md) | Animates a Vector 3 variable from A to B over Duration seconds. |
| [Tween Vector4](tween-vector4.md) | Animates a Vector 4 variable from A to B over Duration seconds. |

## Assets

| Node | Description |
| --- | --- |
| [Async Load Asset](async-load-asset.md) | Loads an asset and its required dependencies in the background while gameplay continues. |
| [Async Load Assets](async-load-assets.md) | Loads several assets and their required dependencies as one request while gameplay continues. |
| [Async Load Class](async-load-class.md) | Loads a Class, with its scripts and required resources, in the background while gameplay continues. |
| [Get Asset Load State](get-asset-load-state.md) | Returns whether an asset is Unloaded, Loading, Loaded or Failed. |
| [Get Load Handle Progress](get-load-handle-progress.md) | Returns how much of a load has finished, from 0 to 1. |
| [Get Load Handle State](get-load-handle-state.md) | Returns whether a load handle is Loading, Loaded, Failed or Released. |
| [Is Asset Loaded](is-asset-loaded.md) | Returns true when an asset is loaded and ready to use right now. |
| [Load Asset Blocking](load-asset-blocking.md) | Loads an asset at High priority and pauses the game until loading finishes. |
| [Load Assets Blocking](load-assets-blocking.md) | Loads several assets together at High priority and pauses the game until loading finishes. |
| [Load Class Blocking](load-class-blocking.md) | Loads a Class at High priority and pauses the game until loading finishes. |
| [Release Load Handle](release-load-handle.md) | Cancels a load that is still pending and releases the handle's hold on its assets. |
| [Request Async Load](request-async-load.md) | Starts loading assets in the background and returns a handle at once, without waiting. |
| [Unload Asset](unload-asset.md) | Releases the load handles that include an asset and belong to the calling object. |
| [Wait For Load Handle](wait-for-load-handle.md) | Waits for a load handle to finish loading while gameplay continues. |

## Asset Registry

| Node | Description |
| --- | --- |
| [Find Assets](find-assets.md) | Lists the assets that match every part of a filter, sorted by path. |
| [Folder Has Assets](folder-has-assets.md) | Returns true when a folder holds at least one packaged asset. |
| [Get Asset By Path](get-asset-by-path.md) | Looks up an asset by its full storage path and returns its details. |
| [Get Asset Data](get-asset-data.md) | Looks up an asset in the packaged asset catalog and returns its details. |
| [Get Asset Dependencies](get-asset-dependencies.md) | Lists the catalog assets that an asset references, sorted by path. |
| [Get Asset Referencers](get-asset-referencers.md) | Lists the catalog assets that reference an asset, sorted by path. |
| [Get Assets By Class](get-assets-by-class.md) | Lists the Class assets of a chosen Class, and optionally of Classes that inherit from it. |
| [Get Assets By Path](get-assets-by-path.md) | Lists the assets in a folder, sorted by path. |
| [Get Assets By Type](get-assets-by-type.md) | Lists the assets of one type, sorted by path. |
| [Get Sub Folders](get-sub-folders.md) | Lists the full paths of the folders below a folder. |

## Save Game

| Node | Description |
| --- | --- |
| [Delete Save](delete-save.md) | Deletes a saved slot, including the older copies kept for migration. |
| [Get Migration Field](get-migration-field.md) | Reads a field of the save being migrated, chosen by its permanent field ID. |
| [Get Save Data](get-save-data.md) | Returns the current values of the default Save Game as one record. |
| [Get Save Field](get-save-field.md) | Returns the value of a Save Game field, chosen by its permanent field ID. |
| [List Saves](list-saves.md) | Lists the saved slots of a profile. |
| [Load Game](load-game.md) | Restores the game from a saved slot. |
| [New Game](new-game.md) | Resets the game's save data to its defaults, ready for a fresh playthrough. |
| [Register Save Actor](register-save-actor.md) | Registers a spawned actor so its state is saved and restored with the game. |
| [Register Save Migration](register-save-migration.md) | Registers a step that upgrades saves from an older Save Game schema version. |
| [Save Game](save-game.md) | Writes the current save data to a slot. |
| [Set Migration Field](set-migration-field.md) | Sets a field of the save being migrated, chosen by its permanent field ID. |
| [Set Save Field](set-save-field.md) | Sets the value of a Save Game field in memory, chosen by its permanent field ID. |

## Game Instance

| Node | Description |
| --- | --- |
| [Get Game Instance](get-game-instance.md) | Returns the Game Instance that lives for the whole play session. |
| [Get Scene Loading Progress](get-scene-loading-progress.md) | Returns how far the main Scene has loaded, from 0 to 1. |
| [Get Scene Reference](get-scene-reference.md) | Returns the main Scene, or null while no Scene is loaded. |

## Subsystem

| Node | Description |
| --- | --- |
| [Get Subsystem](get-subsystem.md) | Returns the running subsystem of a chosen class, or null if none is alive. |

## Project

| Node | Description |
| --- | --- |
| [Get Project Name](get-project-name.md) | Returns the name of the project. |
| [Get Project Version](get-project-version.md) | Returns the version of the project as text. |

## Debug

| Node | Description |
| --- | --- |
| [Draw Debug Arrow](draw-debug-arrow.md) | Draws an arrow from a start position to an end position. |
| [Draw Debug Box](draw-debug-box.md) | Draws a wireframe box at a world position. |
| [Draw Debug Circle](draw-debug-circle.md) | Draws a circle outline at a world position. |
| [Draw Debug Cone](draw-debug-cone.md) | Draws a wireframe cone from a tip point along a direction. |
| [Draw Debug Coordinate System](draw-debug-coordinate-system.md) | Draws red, green and blue axis lines for a position and rotation. |
| [Draw Debug Cylinder](draw-debug-cylinder.md) | Draws a wireframe cylinder between two world positions. |
| [Draw Debug Frustum](draw-debug-frustum.md) | Draws a camera view frustum from a position and rotation. |
| [Draw Debug Line](draw-debug-line.md) | Draws a line between two world positions. |
| [Draw Debug Point](draw-debug-point.md) | Draws a small three-axis cross at a world position. |
| [Draw Debug Rectangle](draw-debug-rectangle.md) | Draws a rectangle outline at a world position. |
| [Draw Debug Sphere](draw-debug-sphere.md) | Draws a wireframe sphere at a world position. |
| [Draw Debug Square](draw-debug-square.md) | Draws a square outline at a world position. |
| [Execute Console Command](execute-console-command.md) | Runs a console command and waits for it to finish. |
| [Execute JavaScript](execute-javascript.md) | Runs your own JavaScript function body inline, with custom input and output pins. |
| [Log](log.md) | Writes a message to the Output Log with a chosen severity and category. |
| [Print](print.md) | Shows any value as on-screen text while the game runs. |
| [Print String](print-string.md) | Shows a string as on-screen text while the game runs. |
| [Report Command](report-command.md) | Sets the success flag and output text returned by the running console command. |

## Editor

| Node | Description |
| --- | --- |
| [Add Data Entry](add-data-entry.md) | Adds a new entry to a Data Tree under a parent entry. |
| [Create Data Tree](create-data-tree.md) | Creates a new, empty Data Tree asset in the project. |
| [Get Editable Data Children](get-editable-data-children.md) | Returns the paths of an entry's immediate children in order, including unsaved edits. |
| [Get Editable Data Descendants](get-editable-data-descendants.md) | Returns the paths of every entry below an entry, including unsaved edits. |
| [Get Editable Data Parent](get-editable-data-parent.md) | Returns the path of an entry's parent, including unsaved edits. |
| [List Data Trees](list-data-trees.md) | Lists the Data Trees in the project, optionally only those that use a chosen Data Definition. |
| [Move Data Subtree](move-data-subtree.md) | Moves an entry and its children under a new parent in a Data Tree. |
| [Read Editable Data Entry](read-editable-data-entry.md) | Reads the values of one Data Tree entry, including unsaved edits. |
| [Read Editable Data Tree](read-editable-data-tree.md) | Returns the paths of every entry in a Data Tree, including unsaved edits. |
| [Remove Data Subtree](remove-data-subtree.md) | Removes an entry and everything below it from a Data Tree. |
| [Reorder Data Children](reorder-data-children.md) | Sets the order of an entry's immediate children in a Data Tree. |
| [Update Data Entry](update-data-entry.md) | Changes the values of an existing Data Tree entry. |
