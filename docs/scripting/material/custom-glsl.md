# Custom GLSL

Runs your own GLSL function body, with the inputs and outputs you define in Details.

## Settings

| Setting | Description |
| --- | --- |
| Return Name | The name and label of the primary output pin. |
| Return Type | The type of the primary output: Float, Vector 2, Vector 3 or Vector 4. |
| Inputs | The input pins. Each name becomes a variable in the function body, and names are case sensitive. |
| Additional Outputs | Extra output pins. Assign each by name in the body before returning. |
| Function Body | The GLSL statements that return the primary output. Shader globals, sampler declarations and preprocessor directives are not allowed; use input pins instead. |

## Notes

- Return the primary output, and assign any additional outputs by name before returning.
- GLSL and WebGL only: it does not run on WebGPU, and changes compile when you press **Render**.
- Using derivatives such as dFdx, or discard, limits the node to the fragment stage.
