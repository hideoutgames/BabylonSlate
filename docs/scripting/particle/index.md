# Particle Graph Nodes

Nodes for Particle Graph emitters, grouped as in **Add Node**.

## Emitter

| Node | Description |
| --- | --- |
| [Create Particle](create-particle.md) | Starts the Particle chain and sets each new particle's speed, lifetime, colour, size and angle. |
| [Emitter Output](emitter-output.md) | Ends the Particle chain and sets how many particles the emitter spawns each second. |

## Shape

| Node | Description |
| --- | --- |
| [Box Shape](box-shape.md) | Spawns particles at random points inside a box and launches them between two directions. |
| [Cone Shape](cone-shape.md) | Spawns particles inside a cone that opens along the emitter's Y axis and launches them outwards. |
| [Cylinder Shape](cylinder-shape.md) | Spawns particles inside a cylinder along the emitter's Y axis and launches them outwards. |
| [Point Shape](point-shape.md) | Spawns particles at the emitter and launches them in a direction picked between two vectors. |
| [Sphere Shape](sphere-shape.md) | Spawns particles inside a sphere around the emitter and launches them outwards. |

## Update

| Node | Description |
| --- | --- |
| [Align Angle](align-angle.md) | Rotates each particle so its up direction follows its direction of travel on screen. |
| [Apply Velocity](apply-velocity.md) | Moves every particle along its direction each frame. |
| [Fade To Dead Color](fade-to-dead-color.md) | Blends each particle from its colour to its dead colour over its lifetime. |
| [Update Angle](update-angle.md) | Sets the rotation of every particle each frame, in radians. |
| [Update Color](update-color.md) | Sets the colour of every particle each frame. |
| [Update Direction](update-direction.md) | Sets the velocity of every particle each frame. |
| [Update Position](update-position.md) | Sets the position of every particle each frame. |
| [Update Scale](update-scale.md) | Sets the width and height scale of every particle each frame. |
| [Update Size](update-size.md) | Sets the size of every particle each frame. |

## Forces

| Node | Description |
| --- | --- |
| [Attractor](attractor.md) | Pulls every particle towards a point, more strongly the closer it gets. |
| [Gravity](gravity.md) | Accelerates every particle by changing its direction each frame. |

## Particle Attributes

| Node | Description |
| --- | --- |
| [Age](age.md) | Returns the seconds since the particle was born. |
| [Angle](angle.md) | Returns the current rotation of the particle in radians. |
| [Dead Color](dead-color.md) | Returns the dead colour that the particle was created with. |
| [Direction](direction.md) | Returns the current velocity of the particle in metres per second. |
| [Initial Color](initial-color.md) | Returns the colour the particle was created with. |
| [Lifetime](lifetime.md) | Returns the total lifetime of the particle in seconds. |
| [Normalized Age](normalized-age.md) | Returns how far through its life the particle is, from 0 at birth to 1 at death. |
| [Particle Color](particle-color.md) | Returns the current colour of the particle. |
| [Position](position.md) | Returns the current position of the particle in world space. |
| [Scale](scale.md) | Returns the current width and height scale of the particle. |
| [Scaled Direction](scaled-direction.md) | Returns the particle's direction multiplied by the seconds simulated this frame. |
| [Size](size.md) | Returns the current size of the particle. |

## System Values

| Node | Description |
| --- | --- |
| [Camera Position](camera-position.md) | Returns the world-space position of the active camera. |
| [Delta Time](delta-time.md) | Returns the seconds simulated in the current frame. |
| [Emitter Position](emitter-position.md) | Returns the world-space position of the emitter. |
| [Time](time.md) | Returns the seconds since the emitter started. |

## Constants

| Node | Description |
| --- | --- |
| [Color](color.md) | Returns a fixed colour, including alpha, that you set in Details. |
| [Float](float.md) | Returns a fixed number that you set in Details. |
| [Vector 2](vector-2.md) | Returns a fixed Vector 2 that you set in Details. |
| [Vector 3](vector-3.md) | Returns a fixed Vector 3 that you set in Details. |

## Utility

| Node | Description |
| --- | --- |
| [Gradient](gradient.md) | Returns a value sampled from a gradient of 2 to 8 stops at a position from 0 to 1. |
| [Random](random.md) | Returns a random value between a minimum and a maximum. |

## Math

| Node | Description |
| --- | --- |
| [Absolute](absolute.md) | Returns the input with any negative sign removed. |
| [Add](add.md) | Returns the sum of two values, component by component. |
| [Arccosine](arccosine.md) | Returns the arccosine of the input as an angle in radians. |
| [Arcsine](arcsine.md) | Returns the arcsine of the input as an angle in radians. |
| [Arctangent](arctangent.md) | Returns the arctangent of the input as an angle in radians. |
| [Ceiling](ceiling.md) | Rounds the input up to the nearest whole number. |
| [Clamp](clamp.md) | Limits a value so that it stays between a minimum and a maximum. |
| [Cosine](cosine.md) | Returns the cosine of an angle in radians. |
| [Degrees](degrees.md) | Converts the input from radians to degrees. |
| [Divide](divide.md) | Divides one value by another, component by component. |
| [Exponential](exponential.md) | Returns e raised to the power of the input. |
| [Exponential 2](exponential-2.md) | Returns 2 raised to the power of the input. |
| [Floor](floor.md) | Rounds the input down to the nearest whole number. |
| [Fraction](fraction.md) | Returns the part of the input after the decimal point. |
| [Lerp](lerp.md) | Blends from one value to another by an amount between 0 and 1. |
| [Logarithm](logarithm.md) | Returns the natural logarithm of the input. |
| [Maximum](maximum.md) | Returns the larger of two values, component by component. |
| [Minimum](minimum.md) | Returns the smaller of two values, component by component. |
| [Modulo](modulo.md) | Returns the remainder after dividing one Float by another. |
| [Multiply](multiply.md) | Multiplies two values together, component by component. |
| [Negate](negate.md) | Flips the sign of the input. |
| [One Minus](one-minus.md) | Returns the result of subtracting the input from 1. |
| [Power](power.md) | Raises a base to the power of an exponent. |
| [Radians](radians.md) | Converts the input from degrees to radians. |
| [Reciprocal](reciprocal.md) | Returns the result of dividing 1 by the input. |
| [Round](round.md) | Rounds the input to the nearest whole number. |
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
| [Distance](distance.md) | Returns the straight-line distance between two Vector 3 positions. |
| [Dot Product](dot-product.md) | Returns the dot product of two Vector 3 values. |
| [Length](length.md) | Returns the length of a Vector 3. |
| [Split](split.md) | Splits a Vector 2, Vector 3 or Color into separate Float components. |

## Logic

| Node | Description |
| --- | --- |
| [Condition](condition.md) | Returns one of two values depending on how two numbers compare. |
