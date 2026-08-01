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
  @location(0) world_normal: vec3f,
  @location(1) color: vec4f,
}

@group(0) @binding(0) var<uniform> camera: CameraData;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
  let instance = instances[instance_index];
  let world_position = instance.model * vec4f(position, 1.0);
  var output: VertexOutput;
  output.position = camera.projection * camera.view * world_position;
  output.world_normal = normalize((instance.model * vec4f(normal, 0.0)).xyz);
  output.color = instance.color;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let light_direction = normalize(vec3f(0.45, 0.8, 0.6));
  let diffuse = max(dot(input.world_normal, light_direction), 0.0);
  let lighting = 0.22 + 0.78 * diffuse;
  return vec4f(input.color.rgb * lighting, input.color.a);
}
`;
