export const VISIBILITY_SHADER = /* wgsl */ `
struct CameraData {
  view: mat4x4f,
  projection: mat4x4f,
}

struct SlotState {
  entity: u32,
  flags: u32,
  payload_entity: u32,
  reserved: u32,
}

struct BoundsData {
  center_radius: vec4f,
}

struct ResourceKeys {
  geometry: u32,
  pipeline: u32,
  material: u32,
  entity: u32,
}

struct DrawIndexedIndirect {
  index_count: u32,
  instance_count: atomic<u32>,
  first_index: u32,
  base_vertex: i32,
  first_instance: u32,
}

struct VisibilityParameters {
  candidate_count: u32,
  run_count: u32,
  reserved_0: u32,
  reserved_1: u32,
}

@group(0) @binding(0) var<uniform> camera: CameraData;
@group(0) @binding(1) var<storage, read> slot_states: array<SlotState>;
@group(0) @binding(2) var<storage, read> slot_bounds: array<BoundsData>;
@group(0) @binding(3) var<storage, read> slot_resources: array<ResourceKeys>;
@group(0) @binding(4) var<storage, read> candidate_slots: array<u32>;
@group(0) @binding(5) var<storage, read> candidate_run_ids: array<u32>;
@group(0) @binding(6) var<storage, read_write> visible_slots: array<u32>;
@group(0) @binding(7) var<storage, read_write> commands: array<DrawIndexedIndirect>;
@group(0) @binding(8) var<uniform> parameters: VisibilityParameters;

fn finite(value: f32) -> bool {
  return value == value && abs(value) <= 3.402823466e38;
}

fn plane_contains(coefficients: vec4f, center: vec3f, radius: f32) -> bool {
  let length_squared = dot(coefficients.xyz, coefficients.xyz);
  if (!finite(length_squared) || length_squared <= 0.0) {
    return true;
  }
  let inverse_length = inverseSqrt(length_squared);
  return dot(coefficients.xyz * inverse_length, center) +
    coefficients.w * inverse_length >= -radius;
}

fn sphere_visible(center_radius: vec4f) -> bool {
  if (!finite(center_radius.x) || !finite(center_radius.y) ||
      !finite(center_radius.z) || !finite(center_radius.w)) {
    return true;
  }
  let view_projection = camera.projection * camera.view;
  let row_0 = vec4f(view_projection[0][0], view_projection[1][0], view_projection[2][0], view_projection[3][0]);
  let row_1 = vec4f(view_projection[0][1], view_projection[1][1], view_projection[2][1], view_projection[3][1]);
  let row_2 = vec4f(view_projection[0][2], view_projection[1][2], view_projection[2][2], view_projection[3][2]);
  let row_3 = vec4f(view_projection[0][3], view_projection[1][3], view_projection[2][3], view_projection[3][3]);
  let center = center_radius.xyz;
  let radius = center_radius.w;
  return plane_contains(row_3 + row_0, center, radius) &&
    plane_contains(row_3 - row_0, center, radius) &&
    plane_contains(row_3 + row_1, center, radius) &&
    plane_contains(row_3 - row_1, center, radius) &&
    plane_contains(row_2, center, radius) &&
    plane_contains(row_3 - row_2, center, radius);
}

@compute @workgroup_size(64)
fn reset_commands(@builtin(global_invocation_id) invocation: vec3u) {
  if (invocation.x < parameters.run_count) {
    atomicStore(&commands[invocation.x].instance_count, 0u);
  }
}

@compute @workgroup_size(64)
fn cull_candidates(@builtin(global_invocation_id) invocation: vec3u) {
  let candidate_index = invocation.x;
  if (candidate_index >= parameters.candidate_count) {
    return;
  }
  let slot = candidate_slots[candidate_index];
  let state = slot_states[slot];
  let resources = slot_resources[slot];
  if ((state.flags & 1u) == 0u || state.entity != state.payload_entity ||
      resources.entity != state.entity || !sphere_visible(slot_bounds[slot].center_radius)) {
    return;
  }
  let run = candidate_run_ids[candidate_index];
  let output = atomicAdd(&commands[run].instance_count, 1u);
  visible_slots[commands[run].first_instance + output] = slot;
}
`;
