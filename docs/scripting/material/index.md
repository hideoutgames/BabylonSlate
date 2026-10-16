# Material Nodes

Nodes for Material and Material Function graphs, grouped as in **Add Node**.

## Output

| Node | Description |
| --- | --- |
| [Material Output](material-output.md) | Receives the final surface settings of a material, such as colour, roughness and opacity. |
| [Particle Output](particle-output.md) | Sets the colour and alpha of each particle drawn with the material. |
| [Post Process Output](post-process-output.md) | Sets the colour of each pixel in a post-process pass. |
| [Text Output](text-output.md) | Sets the colour of text drawn with a Text material. |

## Input

| Node | Description |
| --- | --- |
| [Camera Position](camera-position.md) | Returns the position of the camera in world space. |
| [Environment Sample](environment-sample.md) | Returns the colour of the scene's environment lighting in a direction, blurred by roughness. |
| [Particle Color](particle-color.md) | Returns the colour and alpha the emitter gives to the particle being drawn. |
| [Scene Color](scene-color.md) | Returns the colour of the rendered scene at a position on the screen. |
| [Scene Depth](scene-depth.md) | Returns the linear depth of the rendered scene at a position on the screen. |
| [Scene Normal](scene-normal.md) | Returns the world-space normal of the scene geometry at a position on the screen. |
| [Screen Size](screen-size.md) | Returns the width and height of the screen in pixels. |
| [Screen UV](screen-uv.md) | Returns where the current pixel sits on the screen, from 0 to 1 on each axis. |
| [Time](time.md) | Returns the elapsed time in seconds, for animating a material. |
| [UV](uv.md) | Returns the texture coordinates of the surface, particle quad or text glyph being drawn. |
| [Vertex Color](vertex-color.md) | Returns the vertex colour painted on the mesh, including alpha. |
| [Vertex Normal (Local)](vertex-normal-local.md) | Returns the vertex normal in the mesh's local space, including morph target changes. |
| [Vertex Position (Local)](vertex-position-local.md) | Returns the vertex position in the mesh's local space, including morph target changes. |
| [VertexNormalWS](vertexnormalws.md) | Returns the vertex normal in world space, scaled to a length of 1. |
| [View Direction](view-direction.md) | Returns the direction from the surface point toward the camera, scaled to a length of 1. |
| [Water Surface](water-surface.md) | Returns water data for the current point: wave height, bank distance, depth, time and flow. |
| [Water Waves](water-waves.md) | Calculates animated wave displacement on the GPU, returning offset, height, normal and time for a water surface. |
| [World Normal](world-normal.md) | Returns the surface normal in world space. |
| [World Position](world-position.md) | Returns the position of the surface point in world space, in metres. |
| [World Tangent](world-tangent.md) | Returns the surface tangent direction in world space, scaled to a length of 1. |

## Constants

| Node | Description |
| --- | --- |
| [Color](color.md) | Returns a fixed colour, including alpha, that you set in the **Inspector**. |
| [Float](float.md) | Returns a fixed number that you set in the **Inspector**. |
| [Vector 2](vector-2.md) | Returns a fixed Vector 2 that you set in the **Inspector**. |
| [Vector 3](vector-3.md) | Returns a fixed Vector 3 that you set in the **Inspector**. |
| [Vector 4](vector-4.md) | Outputs a fixed Vector 4 value set in the **Inspector**. |

## Parameters

| Node | Description |
| --- | --- |
| [Color Parameter](color-parameter.md) | Outputs a named colour that can be changed at runtime or overridden per Material Instance. |
| [Float Parameter](float-parameter.md) | Outputs a named Float that can be changed at runtime or overridden per Material Instance. |
| [Texture Parameter](texture-parameter.md) | Outputs a named texture that can be changed at runtime or overridden per Material Instance. |

## Math

| Node | Description |
| --- | --- |
| [Absolute](absolute.md) | Returns the input with any negative sign removed. |
| [Add](add.md) | Returns the sum of two values, component by component. |
| [Arccosine](arccosine.md) | Returns the arccosine of the input as an angle in radians. |
| [Arcsine](arcsine.md) | Returns the arcsine of the input as an angle in radians. |
| [Arctangent](arctangent.md) | Returns the arctangent of the input as an angle in radians. |
| [Arctangent 2](arctangent-2.md) | Returns the angle in radians of the point (X, Y), measured from the positive X axis. |
| [Ceiling](ceiling.md) | Rounds the input up to the nearest whole number. |
| [Clamp](clamp.md) | Limits a value so that it stays between a minimum and a maximum. |
| [Cosine](cosine.md) | Returns the cosine of an angle in radians. |
| [Degrees](degrees.md) | Converts the input from radians to degrees. |
| [Divide](divide.md) | Divides one value by another, component by component. |
| [Exponential](exponential.md) | Returns e raised to the power of the input. |
| [Exponential 2](exponential-2.md) | Returns 2 raised to the power of the input. |
| [Floor](floor.md) | Rounds the input down to the nearest whole number. |
| [Fraction](fraction.md) | Returns the part of the input after the decimal point. |
| [Inverse Square Root](inverse-square-root.md) | Returns 1 divided by the square root of Value. |
| [Logarithm](logarithm.md) | Returns the natural logarithm of the input. |
| [Logarithm 2](logarithm-2.md) | Returns the base-2 logarithm of Value. |
| [Maximum](maximum.md) | Returns the larger of two values, component by component. |
| [Minimum](minimum.md) | Returns the smaller of two values, component by component. |
| [Mix](mix.md) | Blends from A to B by the amount in Alpha. |
| [Modulo](modulo.md) | Returns the remainder after dividing one Float by another. |
| [Multiply](multiply.md) | Multiplies two values together, component by component. |
| [Negate](negate.md) | Flips the sign of the input. |
| [Power](power.md) | Raises a base to the power of an exponent. |
| [Radians](radians.md) | Converts the input from degrees to radians. |
| [Reciprocal](reciprocal.md) | Returns the result of dividing 1 by the input. |
| [Remap](remap.md) | Rescales Value from the range From Min to From Max into the range To Min to To Max. |
| [Round](round.md) | Rounds the input to the nearest whole number. |
| [Saturate](saturate.md) | Limits Value to the range 0 to 1. |
| [Sign](sign.md) | Returns -1, 0 or 1 depending on the sign of the input. |
| [Sine](sine.md) | Returns the sine of an angle in radians. |
| [Smooth Step](smooth-step.md) | Returns 0 below the first edge, 1 above the second, and a smooth curve in between. |
| [Square Root](square-root.md) | Returns the square root of the input. |
| [Step](step.md) | Returns 0 when a value is below an edge, and 1 otherwise. |
| [Subtract](subtract.md) | Subtracts one value from another, component by component. |
| [Tangent](tangent.md) | Returns the tangent of an angle in radians. |

## Vector

| Node | Description |
| --- | --- |
| [Combine](combine.md) | Builds a Vector 2, Vector 3 or Color from separate Float values. |
| [Cross Product](cross-product.md) | Returns the vector perpendicular to both A and B. |
| [Distance](distance.md) | Returns the straight-line distance between two Vector 3 positions. |
| [Dot Product](dot-product.md) | Returns the dot product of two Vector 3 values. |
| [Length](length.md) | Returns the length of a Vector 3. |
| [Normalize](normalize.md) | Scales a vector to a length of 1 without changing its direction. |
| [Reflect](reflect.md) | Reflects Incident around Normal and returns the bounced direction. |
| [Refract](refract.md) | Bends the Incident direction as it passes through a surface with the given Normal and Eta. |
| [Split](split.md) | Splits a Vector 2, Vector 3 or Color into separate Float components. |
| [VectorMask(R)](vectormask-r.md) | Extracts chosen channels from a Vector 4 and outputs them as a Float or a smaller vector. |

## Logic

| Node | Description |
| --- | --- |
| [Equal](equal.md) | Returns 1 where A equals B and 0 where it does not. |
| [Greater Than](greater-than.md) | Returns 1 where A is greater than B and 0 otherwise. |
| [Less Than](less-than.md) | Returns 1 where A is less than B and 0 otherwise. |
| [Not Equal](not-equal.md) | Returns 1 where A differs from B and 0 where it is equal. |
| [Select](select.md) | Chooses between When True and When False using Condition. |

## Derivative

| Node | Description |
| --- | --- |
| [DDX](ddx.md) | Returns how much Value changes between neighbouring pixels in the horizontal screen direction. |
| [DDY](ddy.md) | Returns how much Value changes between neighbouring pixels in the vertical screen direction. |
| [Fwidth](fwidth.md) | Returns the total change of Value across neighbouring pixels: the absolute DDX plus the absolute DDY. |

## Noise

| Node | Description |
| --- | --- |
| [Perlin Noise](perlin-noise.md) | Returns smooth 3D noise for a position, with values from about -1 to 1. |
| [Voronoi Noise](voronoi-noise.md) | Returns a cell pattern: the distance to the nearest cell point and a random value for each cell. |
| [Worley Noise](worley-noise.md) | Returns 3D cell noise as distances to the nearest and second-nearest feature points. |

## Texture

| Node | Description |
| --- | --- |
| [Texture Sample](texture-sample.md) | Samples a texture at UV and returns its colour, its separate channels and the texture itself. |
| [Texture Sample LOD](texture-sample-lod.md) | Samples a texture at a chosen mip level instead of the level the GPU would pick. |
| [Transform UV](transform-uv.md) | Scales and offsets UV coordinates, for tiling and scrolling textures. |

## Shading

| Node | Description |
| --- | --- |
| [Fresnel](fresnel.md) | Returns a value that is 1 where the surface faces the camera and falls toward its edges. |
| [Normal Map](normal-map.md) | Turns a normal map colour into a world-space normal that follows the surface's shape. |

## Color

| Node | Description |
| --- | --- |
| [Desaturate](desaturate.md) | Blends a colour toward grey by the amount set in Level. |
| [Gradient](gradient.md) | Maps a Value from 0 to 1 onto a colour gradient that you edit in the **Inspector**. |

## Landscape

| Node | Description |
| --- | --- |
| [Landscape Coordinates](landscape-coordinates.md) | Returns texture coordinates from the world X and Z position, for tiling textures across a landscape. |
| [Landscape Height](landscape-height.md) | Returns the height of the ground at each point, as its world Y position in metres. |
| [Landscape Layer Blend](landscape-layer-blend.md) | Mixes a Base colour toward a Layer colour by a weight. |
| [Landscape Paint Layers](landscape-paint-layers.md) | Returns the paint weight of each of the four landscape paint layers at each point. |
| [Landscape Slope](landscape-slope.md) | Returns how steep the ground is, from 0 on flat ground to 1 on a vertical face. |

## Functions

| Node | Description |
| --- | --- |
| [Function Inputs](function-inputs.md) | Provides the values passed into a Material Function, with one output pin per declared input. |
| [Function Outputs](function-outputs.md) | Collects the results of a Material Function, with one input pin per declared output. |
| [Material Function](material-function.md) | Runs a Material Function, with pins that match the function's inputs and outputs. |

## Custom

| Node | Description |
| --- | --- |
| [Custom GLSL](custom-glsl.md) | Runs your own GLSL function body, with the inputs and outputs you define in the **Inspector**. |
