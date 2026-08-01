//! Stable, dependency-free raw WebAssembly ABI for the Lume simulation core.

use core::ffi::c_void;
use lume_core::math::{Color, Quat, Vec3};
use lume_core::{
    Camera, Entity, GpuCamera, GpuInstance, Material, MeshRenderer, RenderWorld, Transform, World,
    WorldCapacity,
};

pub const ABI_VERSION: u32 = 2;

struct EngineCore {
    world: World,
    render_world: RenderWorld,
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_create(entity_capacity: u32) -> *mut c_void {
    let entities = usize::try_from(entity_capacity.max(1)).unwrap_or(4_096);
    let capacity = WorldCapacity {
        entities,
        transforms: entities,
        mesh_renderers: entities,
        cameras: 8,
        materials: entities.min(1_024),
    };
    Box::into_raw(Box::new(EngineCore {
        world: World::with_capacity(capacity),
        render_world: RenderWorld::with_capacity(entities, 8),
    }))
    .cast()
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

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_spawn(engine: *mut c_void, entity_raw: u32) -> u32 {
    with_engine(engine, |core| {
        core.world.claim(Entity::from_raw(entity_raw))
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_despawn(engine: *mut c_void, entity_raw: u32) -> u32 {
    with_engine(engine, |core| {
        core.world.despawn(Entity::from_raw(entity_raw))
    }) as u32
}

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

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_add_material(
    engine: *mut c_void,
    entity_raw: u32,
    red: f32,
    green: f32,
    blue: f32,
    alpha: f32,
) -> u32 {
    with_engine(engine, |core| {
        core.world.add_material(
            Entity::from_raw(entity_raw),
            Material {
                color: Color::new([red, green, blue, alpha]),
            },
        )
    }) as u32
}

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
                geometry,
                material: Entity::from_raw(material_raw),
            },
        )
    }) as u32
}

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

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_update(engine: *mut c_void) -> u32 {
    with_engine(engine, |core| {
        core.world.update();
        core.render_world.extract(&core.world).is_ok()
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_set_camera_aspect(engine: *mut c_void, aspect: f32) -> u32 {
    with_engine(engine, |core| {
        if aspect <= 0.0 {
            return false;
        }
        core.world.set_camera_aspect(aspect);
        true
    }) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_engine_entity_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.world.entity_count() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_instance_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.instances().len() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_camera_count(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.cameras().len() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_entity_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.entity_capacity() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_camera_capacity(engine: *mut c_void) -> u32 {
    with_engine_value(engine, |core| core.render_world.camera_capacity() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_entities_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.render_world.entities_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_geometries_ptr(engine: *mut c_void) -> *const u32 {
    with_engine_value(engine, |core| core.render_world.geometries_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_instances_ptr(engine: *mut c_void) -> *const GpuInstance {
    with_engine_value(engine, |core| core.render_world.instances_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn lume_render_cameras_ptr(engine: *mut c_void) -> *const GpuCamera {
    with_engine_value(engine, |core| core.render_world.cameras_capacity_ptr())
        .unwrap_or(core::ptr::null())
}

fn with_engine(engine: *mut c_void, operation: impl FnOnce(&mut EngineCore) -> bool) -> bool {
    // SAFETY: JS only receives pointers created by this module. Null is rejected.
    let Some(core) = (unsafe { engine.cast::<EngineCore>().as_mut() }) else {
        return false;
    };
    operation(core)
}

fn with_engine_value<T>(
    engine: *mut c_void,
    operation: impl FnOnce(&EngineCore) -> T,
) -> Option<T> {
    // SAFETY: JS only receives pointers created by this module. Null is rejected.
    let core = unsafe { engine.cast::<EngineCore>().as_ref() }?;
    Some(operation(core))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_can_create_update_and_destroy_a_world() {
        let engine = lume_engine_create(16);
        assert!(!engine.is_null());
        assert_eq!(lume_engine_spawn(engine, 0), 1);
        assert_eq!(
            lume_engine_add_transform(engine, 0, 0.0, 0.0, -5.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,),
            1
        );
        assert_eq!(lume_engine_update(engine), 1);
        // SAFETY: pointer was created above and has not yet been destroyed.
        unsafe { lume_engine_destroy(engine) };
    }
}
