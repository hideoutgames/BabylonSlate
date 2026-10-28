import "@babylonjs/loaders/glTF/2.0/glTFLoader";
// Models load without their materials (`skipMaterials`). The material and texture extensions stay registered: the
// loader refuses a file that lists an unregistered extension as required.
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_transform";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_draco_mesh_compression";
import "@babylonjs/loaders/glTF/2.0/Extensions/EXT_meshopt_compression";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_mesh_quantization";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_basisu";
