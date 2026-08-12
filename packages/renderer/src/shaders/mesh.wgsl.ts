export const MESH_SHADER = /* wgsl */ `
struct CameraData {
  view: mat4x4f,
  projection: mat4x4f,
}

struct InstanceData {
  model: mat4x4f,
  color: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@group(0) @binding(0) var<uniform> camera: CameraData;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(0) @binding(2) var<storage, read> visible_slots: array<u32>;

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
  let instance = instances[visible_slots[instance_index]];
  let world_position = instance.model * vec4f(position, 1.0);
  var output: VertexOutput;
  output.position = camera.projection * camera.view * world_position;
  output.color = instance.color;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
`;
