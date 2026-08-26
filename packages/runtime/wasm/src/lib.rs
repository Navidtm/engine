//! Stable, dependency-free raw WebAssembly ABI for the Lume simulation core.

use core::ffi::c_void;
use lume_core::math::{Color, Quat, Vec3};
use lume_core::{
    Bounds, Camera, Entity, GeometryHandle, GpuBounds, GpuCamera, GpuInstance, GpuResourceKeys,
    GpuSlotState, MAX_ENTITY_CAPACITY, Material, MaterialHandle, MeshRenderer, RenderWorld,
    Transform, VisibleRenderBuffer, World, WorldCapacity,
};

/// ABI revision required by the TypeScript runtime before it calls any export.
pub const ABI_VERSION: u32 = 11;

const TRANSFORM_UPDATE_FLOATS: usize = 10;

struct EngineCore {
    world: World,
    render_world: RenderWorld,
    visible: VisibleRenderBuffer,
    candidates: VisibleRenderBuffer,
    visibility_valid: bool,
    candidates_valid: bool,
    transform_update_generations: Box<[u32]>,
    transform_update_values: Box<[[f32; TRANSFORM_UPDATE_FLOATS]]>,
    transform_update_masks: Box<[u32]>,
    transform_range_starts: Box<[u32]>,
    transform_range_counts: Box<[u32]>,
}

/// Returns [`ABI_VERSION`] for TypeScript-side compatibility validation.
#[unsafe(no_mangle)]
pub extern "C" fn lume_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocates the complete fixed-capacity simulation and render core.
///
/// The arguments independently bound entity/render storage, transform staging,
/// resource-handle indices, and each component store. The returned opaque
/// pointer is owned by the caller and must be released exactly once with
/// [`lume_engine_destroy`].
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_create(
    entity_capacity: u32,
    transform_capacity: u32,
    resource_capacity: u32,
    mesh_renderer_capacity: u32,
    camera_capacity: u32,
    bounds_capacity: u32,
) -> *mut c_void {
    let entities = usize::try_from(entity_capacity.max(1))
        .unwrap_or(4_096)
        .min(MAX_ENTITY_CAPACITY);
    let transforms = usize::try_from(transform_capacity.max(1))
        .unwrap_or(4_096)
        .min(entities);
    let resources = normalized_resource_capacity(resource_capacity);
    let mesh_renderers = usize::try_from(mesh_renderer_capacity)
        .unwrap_or(entities)
        .min(entities);
    let cameras = usize::try_from(camera_capacity.max(1))
        .unwrap_or(8)
        .min(entities);
    let bounds = usize::try_from(bounds_capacity)
        .unwrap_or(entities)
        .min(entities);
    let capacity = WorldCapacity {
        entities,
        transforms,
        mesh_renderers,
        cameras,
        // The capacity includes resource-handle zero, which is reserved by the API.
        materials: resources,
        bounds,
    };
    Box::into_raw(Box::new(EngineCore {
        world: World::with_capacity(capacity),
        render_world: RenderWorld::with_capacity(entities, cameras),
        visible: VisibleRenderBuffer::with_capacity(entities),
        candidates: VisibleRenderBuffer::with_capacity(entities),
        visibility_valid: false,
        candidates_valid: false,
        transform_update_generations: vec![0; transforms].into_boxed_slice(),
        transform_update_values: vec![[0.0; TRANSFORM_UPDATE_FLOATS]; transforms]
            .into_boxed_slice(),
        transform_update_masks: vec![0; transforms].into_boxed_slice(),
        transform_range_starts: vec![0; transforms].into_boxed_slice(),
        transform_range_counts: vec![0; transforms].into_boxed_slice(),
    }))
    .cast()
}

fn normalized_resource_capacity(resource_capacity: u32) -> usize {
    usize::try_from(resource_capacity.max(1))
        .unwrap_or(4_096)
        .min(MAX_ENTITY_CAPACITY)
}

/// # Safety
/// `engine` must be a live pointer returned by `lume_engine_create` and must not
/// be used again after this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lume_engine_destroy(engine: *mut c_void) {
    if !engine.is_null() {
        // SAFETY: guaranteed by the exported function contract.
        unsafe { drop(Box::from_raw(engine.cast::<EngineCore>())) };
    }
}

/// Claims the supplied packed generational entity identity; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_spawn(engine: *mut c_void, entity_raw: u32) -> u32 {
    with_engine(engine, |core| {
        core.world.claim(Entity::from_raw(entity_raw))
    }) as u32
}

/// Despawns a matching live entity and all owned components; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_despawn(engine: *mut c_void, entity_raw: u32) -> u32 {
    with_engine(engine, |core| {
        core.world.despawn(Entity::from_raw(entity_raw))
    }) as u32
}

/// Adds or replaces a transform from position, `xyzw` quaternion, and scale values.
///
/// Returns `1` only when the entity is live and component capacity permits it.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_transform(
    engine: *mut c_void,
    entity_raw: u32,
    px: f32,
    py: f32,
    pz: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    qw: f32,
    sx: f32,
    sy: f32,
    sz: f32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_transform(
            Entity::from_raw(entity_raw),
            Transform {
                local_position: Vec3::new([px, py, pz]),
                rotation: Quat::new([qx, qy, qz, qw]),
                scale: Vec3::new([sx, sy, sz]),
                ..Transform::default()
            },
        )
    }) as u32
}

/// Removes a matching basic-material resource generation; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_remove_material(engine: *mut c_void, material_raw: u32) -> u32 {
    with_engine(engine, |core| {
        core.world
            .remove_material(MaterialHandle::from_raw(material_raw))
    }) as u32
}

/// Returns the immutable number of WASM transform staging slots.
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_update_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        core.transform_update_generations.len() as u32
    })
    .unwrap_or(0)
}

/// Returns mutable staging generations, one `u32` per transform slot.
///
/// The pointer remains valid until the engine is destroyed; JS must not retain
/// typed-array views across WebAssembly memory growth.
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_update_generations_ptr(engine: *mut c_void) -> *mut u32 {
    with_engine_mut_value(engine, |core| {
        core.transform_update_generations.as_mut_ptr()
    })
    .unwrap_or(core::ptr::null_mut())
}

/// Returns mutable packed staging values, ten `f32` values per transform slot.
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_update_values_ptr(engine: *mut c_void) -> *mut f32 {
    with_engine_mut_value(engine, |core| {
        core.transform_update_values.as_mut_ptr().cast::<f32>()
    })
    .unwrap_or(core::ptr::null_mut())
}

/// Returns mutable per-slot transform field masks.
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_update_masks_ptr(engine: *mut c_void) -> *mut u32 {
    with_engine_mut_value(engine, |core| core.transform_update_masks.as_mut_ptr())
        .unwrap_or(core::ptr::null_mut())
}

/// Returns mutable starts for contiguous staged transform ranges.
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_range_starts_ptr(engine: *mut c_void) -> *mut u32 {
    with_engine_mut_value(engine, |core| core.transform_range_starts.as_mut_ptr())
        .unwrap_or(core::ptr::null_mut())
}

/// Returns mutable counts paired with [`lume_transform_range_starts_ptr`].
#[unsafe(no_mangle)]
pub extern "C" fn lume_transform_range_counts_ptr(engine: *mut c_void) -> *mut u32 {
    with_engine_mut_value(engine, |core| core.transform_range_counts.as_mut_ptr())
        .unwrap_or(core::ptr::null_mut())
}

/// Applies up to `range_count` caller-written transform ranges and returns accepted updates.
///
/// Invalid/stale entities are skipped, and masks are cleared after each visited
/// slot so one staging epoch cannot be applied twice.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_apply_transform_ranges(engine: *mut c_void, range_count: u32) -> u32 {
    with_engine_mut_value(engine, |core| {
        let ranges = usize::try_from(range_count)
            .unwrap_or(usize::MAX)
            .min(core.transform_range_starts.len());
        let mut applied = 0;
        for range in 0..ranges {
            let start = core.transform_range_starts[range] as usize;
            let end = start
                .saturating_add(core.transform_range_counts[range] as usize)
                .min(core.transform_update_generations.len());
            for index in start..end {
                let raw = (core.transform_update_generations[index] << 20) | index as u32;
                let entity = Entity::from_raw(raw);
                let value = core.transform_update_values[index];
                let mask = core.transform_update_masks[index];
                if core.world.update_transform_fields(entity, mask, &value) {
                    applied += 1;
                }
                core.transform_update_masks[index] = 0;
            }
        }
        applied
    })
    .unwrap_or(0)
}

/// Adds or replaces a linear RGBA basic material; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_material(
    engine: *mut c_void,
    material_raw: u32,
    red: f32,
    green: f32,
    blue: f32,
    alpha: f32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_material(
            MaterialHandle::from_raw(material_raw),
            Material {
                color: Color::new([red, green, blue, alpha]),
                ..Material::default()
            },
        )
    }) as u32
}

/// Adds or replaces a mesh renderer linked to a packed material handle.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_mesh_renderer(
    engine: *mut c_void,
    entity_raw: u32,
    geometry: u32,
    material_raw: u32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_mesh_renderer(
            Entity::from_raw(entity_raw),
            MeshRenderer {
                geometry: GeometryHandle::from_raw(geometry),
                material: MaterialHandle::from_raw(material_raw),
            },
        )
    }) as u32
}

/// Adds or replaces a local-space bounding sphere with a non-negative radius.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_bounds(
    engine: *mut c_void,
    entity_raw: u32,
    center_x: f32,
    center_y: f32,
    center_z: f32,
    radius: f32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_bounds(
            Entity::from_raw(entity_raw),
            Bounds {
                center: Vec3::new([center_x, center_y, center_z]),
                radius,
            },
        )
    }) as u32
}

/// Adds or replaces a perspective camera using a radians field of view.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_camera(
    engine: *mut c_void,
    entity_raw: u32,
    vertical_fov_radians: f32,
    near: f32,
    far: f32,
    aspect: f32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_camera(
            Entity::from_raw(entity_raw),
            Camera {
                vertical_fov_radians,
                near,
                far,
                aspect,
                ..Camera::default()
            },
        )
    }) as u32
}

/// Removes a component selected by transport ID `1..=5`; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_remove_component(
    engine: *mut c_void,
    entity_raw: u32,
    component: u32,
) -> u32 {
    with_engine(engine, |core| {
        core.world
            .remove_component(Entity::from_raw(entity_raw), component)
    }) as u32
}

/// Advances ECS systems, extracts renderer data, culls it, and returns success as `1`.
///
/// Capacity failures return `0`; no fallback allocation occurs in this hot path.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_update(engine: *mut c_void) -> u32 {
    with_engine(engine, |core| {
        update_systems(core);
        extract_render_world(core) && update_visibility(core)
    }) as u32
}

/// Advances ECS systems only. Used by pull-sampled split instrumentation.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_update_systems(engine: *mut c_void) -> u32 {
    with_engine(engine, |core| {
        update_systems(core);
        true
    }) as u32
}

/// Extracts the RenderWorld only. Used by pull-sampled split instrumentation.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_extract(engine: *mut c_void) -> u32 {
    with_engine(engine, extract_render_world) as u32
}

/// Updates visibility only. Used by pull-sampled split instrumentation.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_update_visibility(engine: *mut c_void) -> u32 {
    with_engine(engine, update_visibility) as u32
}

/// Updates all cameras to a positive viewport aspect ratio; returns `1` on success.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_set_camera_aspect(engine: *mut c_void, aspect: f32) -> u32 {
    with_engine(engine, |core| core.world.set_camera_aspect(aspect)) as u32
}

/// Invalidates renderer-derived caches after device reconstruction.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_invalidate_renderer_cache(engine: *mut c_void) -> u32 {
    with_engine(engine, |core| {
        core.render_world.invalidate_renderer_cache();
        core.visible.invalidate_renderer_cache();
        core.candidates.invalidate_renderer_cache();
        core.visibility_valid = false;
        core.candidates_valid = false;
        true
    }) as u32
}

/// Returns the number of live ECS entities, or zero for a null engine pointer.
#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_entity_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.world.entity_count() as u32).unwrap_or(0)
}

/// Returns extracted instance count before visibility culling.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_instance_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.instance_count() as u32).unwrap_or(0)
}

/// Returns extracted camera count.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_camera_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.cameras().len() as u32).unwrap_or(0)
}

/// Returns `1` when camera GPU records changed during the current frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_cameras_dirty(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.cameras_dirty() as u32).unwrap_or(0)
}

/// Returns the fixed extracted-instance capacity.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_entity_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.entity_capacity() as u32).unwrap_or(0)
}

/// Returns the fixed extracted-camera capacity.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_camera_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.camera_capacity() as u32).unwrap_or(0)
}

/// Returns the stable pointer to extracted entity IDs.
///
/// Consume at most `lume_render_instance_count` values and recreate views after
/// WASM memory growth.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_entities_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.render_world.entities_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to extracted geometry IDs in instance order.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_geometries_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.render_world.geometries_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to extracted `GpuInstance` records.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_instances_ptr(engine: *mut c_void) -> *const GpuInstance {
    with_engine_value(engine, |core| core.render_world.instances_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to persistent slot lifecycle records.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_slot_states_ptr(engine: *mut c_void) -> *const GpuSlotState {
    with_engine_value(engine, |core| core.render_world.slot_states_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to persistent world-space bounds records.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_slot_bounds_ptr(engine: *mut c_void) -> *const GpuBounds {
    with_engine_value(engine, |core| core.render_world.slot_bounds_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to persistent resource-key records.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_slot_resources_ptr(engine: *mut c_void) -> *const GpuResourceKeys {
    with_engine_value(engine, |core| {
        core.render_world.slot_resources_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the number of coalesced persistent-instance ranges changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_dirty_range_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        core.render_world.dirty_range_starts().len() as u32
    })
    .unwrap_or(0)
}

/// Returns the stable pointer to dirty persistent-instance range starts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_dirty_range_starts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.dirty_range_starts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to dirty persistent-instance range counts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_dirty_range_counts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.dirty_range_counts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the number of coalesced slot-state ranges changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_state_dirty_range_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        core.render_world.state_dirty_ranges().0.len() as u32
    })
    .unwrap_or(0)
}

/// Returns the stable pointer to slot-state dirty range starts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_state_dirty_range_starts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.state_dirty_range_starts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to slot-state dirty range counts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_state_dirty_range_counts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.state_dirty_range_counts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the number of coalesced bounds ranges changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_bounds_dirty_range_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        core.render_world.bounds_dirty_ranges().0.len() as u32
    })
    .unwrap_or(0)
}

/// Returns the stable pointer to bounds dirty range starts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_bounds_dirty_range_starts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.bounds_dirty_range_starts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to bounds dirty range counts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_bounds_dirty_range_counts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.bounds_dirty_range_counts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the number of coalesced resource-key ranges changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_resource_dirty_range_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        core.render_world.resource_dirty_ranges().0.len() as u32
    })
    .unwrap_or(0)
}

/// Returns the stable pointer to resource-key dirty range starts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_resource_dirty_range_starts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.resource_dirty_range_starts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to resource-key dirty range counts.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_resource_dirty_range_counts_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| {
        core.render_world.resource_dirty_range_counts_capacity_ptr()
    })
    .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to extracted `GpuCamera` records.
#[unsafe(no_mangle)]
pub extern "C" fn lume_render_cameras_ptr(engine: *mut c_void) -> *const GpuCamera {
    with_engine_value(engine, |core| core.render_world.cameras_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the number of visible instances after CPU frustum culling.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.visible.len() as u32).unwrap_or(0)
}

/// Returns the fixed capacity of the visible-instance buffers.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.visible.capacity() as u32).unwrap_or(0)
}

/// Returns `1` when visible slot membership or grouped order changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_slots_dirty(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.visible.slots_dirty() as u32).unwrap_or(0)
}

/// Returns the stable pointer to visible geometry IDs in grouped draw order.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_geometries_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.visible.geometries_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to visible pipeline IDs in grouped draw order.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_pipelines_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.visible.pipelines_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to visible material IDs in grouped draw order.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_materials_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.visible.materials_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns the stable pointer to visible persistent-instance slot IDs in draw order.
#[unsafe(no_mangle)]
pub extern "C" fn lume_visible_slots_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.visible.slots_capacity_ptr()).unwrap_or(core::ptr::null())
}

/// Returns the number of grouped, uncullled GPU visibility candidates.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.candidates.len() as u32).unwrap_or(0)
}

/// Returns `1` when GPU candidate membership or order changed this frame.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_slots_dirty(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| {
        (core.candidates.slots_dirty() || core.candidates.render_keys_dirty()) as u32
    })
    .unwrap_or(0)
}

/// Returns grouped candidate geometry handles.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_geometries_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.candidates.geometries_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns grouped candidate pipeline identifiers.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_pipelines_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.candidates.pipelines_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns grouped candidate material handles.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_materials_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.candidates.materials_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

/// Returns grouped candidate persistent-slot indices.
#[unsafe(no_mangle)]
pub extern "C" fn lume_candidate_slots_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.candidates.slots_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

fn with_engine(engine: *mut c_void, operation: impl FnOnce(&mut EngineCore) -> bool) -> bool {
    // SAFETY: JS only receives pointers created by this module. Null is rejected.
    let Some(core) = (unsafe { engine.cast::<EngineCore>().as_mut() }) else {
        return false;
    };
    operation(core)
}

fn update_systems(core: &mut EngineCore) {
    core.world.update();
}

fn extract_render_world(core: &mut EngineCore) -> bool {
    if core.render_world.extract(&core.world).is_err() {
        core.visibility_valid = false;
        core.candidates_valid = false;
        return false;
    }
    true
}

fn update_visibility(core: &mut EngineCore) -> bool {
    if !core.candidates_valid || core.render_world.snapshot_changed() {
        core.candidates_valid = core.candidates.collect_all(&core.render_world).is_ok();
    } else {
        core.candidates.retain_unchanged();
    }
    if !core.visibility_valid
        || core.render_world.snapshot_changed()
        || core.render_world.cameras_dirty()
    {
        core.visibility_valid = core.visible.cull(&core.render_world).is_ok();
    } else {
        core.visible.retain_unchanged();
    }
    core.visibility_valid && core.candidates_valid
}

fn with_engine_value<T>(
    engine: *mut c_void,
    operation: impl FnOnce(&EngineCore) -> T,
) -> Option<T> {
    // SAFETY: JS only receives pointers created by this module. Null is rejected.
    let core = unsafe { engine.cast::<EngineCore>().as_ref() }?;
    Some(operation(core))
}

fn with_engine_mut_value<T>(
    engine: *mut c_void,
    operation: impl FnOnce(&mut EngineCore) -> T,
) -> Option<T> {
    // SAFETY: JS only receives pointers created by this module. Null is rejected.
    let core = unsafe { engine.cast::<EngineCore>().as_mut() }?;
    Some(operation(core))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_capacity_is_clamped_before_allocating_registry_storage() {
        assert_eq!(normalized_resource_capacity(0), 1);
        assert_eq!(normalized_resource_capacity(u32::MAX), MAX_ENTITY_CAPACITY);
    }

    #[test]
    fn abi_can_create_update_and_destroy_a_world() {
        let engine = lume_engine_create(16, 16, 16, 16, 8, 16);
        assert!(!engine.is_null());
        assert_eq!(lume_engine_spawn(engine, 0), 1);
        assert_eq!(lume_engine_spawn(engine, 1), 1);
        assert_eq!(lume_engine_spawn(engine, 2), 1);
        assert_eq!(
            lume_engine_add_transform(engine, 0, 0.0, 0.0, -5.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,),
            1
        );
        assert_eq!(lume_engine_add_material(engine, 3, 1.0, 0.0, 0.0, 1.0), 1);
        assert_eq!(lume_engine_add_mesh_renderer(engine, 0, 1, 3), 1);
        assert_eq!(lume_engine_add_bounds(engine, 0, 0.0, 0.0, 0.0, 1.0), 1);
        assert_eq!(
            lume_engine_add_transform(engine, 2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,),
            1
        );
        assert_eq!(
            lume_engine_add_camera(engine, 2, 60.0_f32.to_radians(), 0.1, 100.0, 1.0),
            1
        );
        assert_eq!(
            lume_engine_add_camera(engine, 2, f32::NAN, 0.1, 100.0, 1.0),
            0
        );
        assert_eq!(lume_engine_set_camera_aspect(engine, f32::NAN), 0);
        assert_eq!(lume_engine_update_systems(engine), 1);
        assert_eq!(lume_engine_extract(engine), 1);
        assert_eq!(lume_engine_update_visibility(engine), 1);
        assert_eq!(lume_render_instance_count(engine), 1);
        assert_eq!(lume_visible_count(engine), 1);
        assert!(!lume_visible_geometries_ptr(engine).is_null());
        assert!(!lume_visible_slots_ptr(engine).is_null());
        assert_eq!(lume_render_dirty_range_count(engine), 1);
        assert!(!lume_render_dirty_range_starts_ptr(engine).is_null());
        assert!(!lume_render_dirty_range_counts_ptr(engine).is_null());
        assert_eq!(lume_engine_update(engine), 1);
        assert_eq!(lume_render_dirty_range_count(engine), 0);
        assert_eq!(lume_visible_slots_dirty(engine), 0);
        assert_eq!(lume_transform_update_capacity(engine), 16);
        // SAFETY: both staging pointers address initialized storage owned by the live engine.
        unsafe {
            *lume_transform_update_generations_ptr(engine) = 0;
            *lume_transform_update_masks_ptr(engine) = 1;
            *lume_transform_range_starts_ptr(engine) = 0;
            *lume_transform_range_counts_ptr(engine) = 2;
            let values = lume_transform_update_values_ptr(engine);
            for (index, value) in [2.0, 3.0, -4.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]
                .into_iter()
                .enumerate()
            {
                *values.add(index) = value;
            }
            *lume_transform_update_generations_ptr(engine).add(1) = 0;
            *lume_transform_update_masks_ptr(engine).add(1) = 1;
            *values.add(TRANSFORM_UPDATE_FLOATS) = 8.0;
        }
        assert_eq!(
            lume_engine_add_transform(engine, 1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0),
            1
        );
        assert_eq!(lume_engine_apply_transform_ranges(engine, 1), 2);
        // SAFETY: the pointer is live and exclusively owned by this test.
        let core = unsafe { &*engine.cast::<EngineCore>() };
        let transform = core.world.transforms().get(Entity::from_raw(0)).unwrap();
        assert_eq!(transform.local_position, Vec3::new([2.0, 3.0, -4.0]));
        assert_eq!(transform.scale, Vec3::new([1.0, 1.0, 1.0]));
        assert_eq!(
            core.world
                .transforms()
                .get(Entity::from_raw(1))
                .unwrap()
                .local_position,
            Vec3::new([8.0, 0.0, 0.0])
        );
        assert_eq!(lume_engine_update(engine), 1);
        // SAFETY: pointer was created above and has not yet been destroyed.
        unsafe { lume_engine_destroy(engine) };
    }

    #[test]
    fn abi_enforces_configured_component_resource_and_render_capacities() {
        let engine = lume_engine_create(4, 3, 3, 1, 2, 1);
        assert!(!engine.is_null());
        assert_eq!(lume_transform_update_capacity(engine), 3);
        assert_eq!(lume_render_entity_capacity(engine), 4);
        assert_eq!(lume_render_camera_capacity(engine), 2);

        for entity in 0..4 {
            assert_eq!(lume_engine_spawn(engine, entity), 1);
        }
        assert_eq!(lume_engine_spawn(engine, 4), 0);

        for entity in 0..3 {
            assert_eq!(
                lume_engine_add_transform(
                    engine, entity, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,
                ),
                1
            );
        }
        assert_eq!(
            lume_engine_add_transform(engine, 3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,),
            0
        );

        assert_eq!(lume_engine_add_material(engine, 1, 1.0, 0.0, 0.0, 1.0), 1);
        assert_eq!(lume_engine_add_material(engine, 2, 0.0, 1.0, 0.0, 1.0), 1);
        assert_eq!(lume_engine_add_material(engine, 3, 0.0, 0.0, 1.0, 1.0), 0);

        assert_eq!(lume_engine_add_mesh_renderer(engine, 0, 1, 1), 1);
        assert_eq!(lume_engine_add_mesh_renderer(engine, 1, 1, 1), 0);
        assert_eq!(lume_engine_add_camera(engine, 0, 1.0, 0.1, 10.0, 1.0), 1);
        assert_eq!(lume_engine_add_camera(engine, 1, 1.0, 0.1, 10.0, 1.0), 1);
        assert_eq!(lume_engine_add_camera(engine, 2, 1.0, 0.1, 10.0, 1.0), 0);
        assert_eq!(lume_engine_add_bounds(engine, 0, 0.0, 0.0, 0.0, 1.0), 1);
        assert_eq!(lume_engine_add_bounds(engine, 1, 0.0, 0.0, 0.0, 1.0), 0);

        // SAFETY: pointer was created above and has not yet been destroyed.
        unsafe { lume_engine_destroy(engine) };

        let zero_components = lume_engine_create(1, 1, 3, 0, 1, 0);
        assert!(!zero_components.is_null());
        assert_eq!(lume_engine_spawn(zero_components, 0), 1);
        assert_eq!(lume_engine_add_mesh_renderer(zero_components, 0, 1, 1), 0);
        assert_eq!(
            lume_engine_add_bounds(zero_components, 0, 0.0, 0.0, 0.0, 1.0),
            0
        );
        // SAFETY: pointer was created above and has not yet been destroyed.
        unsafe { lume_engine_destroy(zero_components) };
    }
}
