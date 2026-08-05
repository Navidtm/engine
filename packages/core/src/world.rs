use crate::components::{Bounds, Camera, MeshRenderer, Transform};
use crate::ecs::{Entity, EntityAllocator, SparseSet};
use crate::material::{BasicMaterial, MaterialHandle, MaterialRegistry};
use crate::systems::{update_cameras, update_transforms};

#[derive(Clone, Copy, Debug)]
pub struct WorldCapacity {
    pub entities: usize,
    pub transforms: usize,
    pub mesh_renderers: usize,
    pub cameras: usize,
    pub materials: usize,
    pub bounds: usize,
}

impl Default for WorldCapacity {
    fn default() -> Self {
        Self {
            entities: 4_096,
            transforms: 4_096,
            mesh_renderers: 4_096,
            cameras: 8,
            materials: 256,
            bounds: 4_096,
        }
    }
}

pub struct World {
    entities: EntityAllocator,
    pub transforms: SparseSet<Transform>,
    pub mesh_renderers: SparseSet<MeshRenderer>,
    pub cameras: SparseSet<Camera>,
    pub bounds: SparseSet<Bounds>,
    pub materials: MaterialRegistry,
}

impl World {
    #[must_use]
    pub fn with_capacity(capacity: WorldCapacity) -> Self {
        Self {
            entities: EntityAllocator::with_capacity(capacity.entities),
            transforms: SparseSet::with_capacity(capacity.entities, capacity.transforms),
            mesh_renderers: SparseSet::with_capacity(capacity.entities, capacity.mesh_renderers),
            cameras: SparseSet::with_capacity(capacity.entities, capacity.cameras),
            bounds: SparseSet::with_capacity(capacity.entities, capacity.bounds),
            materials: MaterialRegistry::with_capacity(capacity.entities, capacity.materials),
        }
    }

    pub fn spawn(&mut self) -> Option<Entity> {
        self.entities.spawn()
    }

    pub fn claim(&mut self, entity: Entity) -> bool {
        self.entities.claim(entity)
    }

    pub fn despawn(&mut self, entity: Entity) -> bool {
        if !self.entities.despawn(entity) {
            return false;
        }
        self.transforms.remove(entity);
        self.mesh_renderers.remove(entity);
        self.cameras.remove(entity);
        self.bounds.remove(entity);
        self.materials.remove(MaterialHandle::from_entity(entity));
        true
    }

    #[must_use]
    pub fn is_alive(&self, entity: Entity) -> bool {
        self.entities.is_alive(entity)
    }

    #[must_use]
    pub fn entity_count(&self) -> usize {
        self.entities.len()
    }

    pub fn add_transform(&mut self, entity: Entity, value: Transform) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.transforms.insert(entity, value).is_ok()
    }

    pub fn update_transform_fields(
        &mut self,
        entity: Entity,
        mask: u32,
        value: &[f32; 10],
    ) -> bool {
        if !self.is_alive(entity) || mask == 0 || mask & !15 != 0 {
            return false;
        }
        let Some(transform) = self.transforms.get_mut(entity) else {
            return false;
        };
        if mask & 1 != 0 {
            transform.local_position = crate::math::Vec3::new([value[0], value[1], value[2]]);
        }
        if mask & 2 != 0 {
            transform.rotation = crate::math::Quat::new([value[3], value[4], value[5], value[6]]);
        }
        if mask & 4 != 0 {
            transform.scale = crate::math::Vec3::new([value[7], value[8], value[9]]);
        }
        true
    }

    pub fn add_mesh_renderer(&mut self, entity: Entity, value: MeshRenderer) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        if !self.mesh_renderers.can_insert(entity)
            || (!self.bounds.contains(entity) && !self.bounds.can_insert(entity))
        {
            return false;
        }
        let mesh_added = self.mesh_renderers.insert(entity, value).is_ok();
        let bounds_added =
            self.bounds.contains(entity) || self.bounds.insert(entity, Bounds::default()).is_ok();
        mesh_added && bounds_added
    }

    pub fn add_camera(&mut self, entity: Entity, value: Camera) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.cameras.insert(entity, value).is_ok()
    }

    pub fn add_bounds(&mut self, entity: Entity, value: Bounds) -> bool {
        if !self.is_alive(entity) || value.radius < 0.0 {
            return false;
        }
        self.bounds.insert(entity, value).is_ok()
    }

    pub fn add_material(&mut self, entity: Entity, value: BasicMaterial) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.materials
            .insert(MaterialHandle::from_entity(entity), value)
            .is_ok()
    }

    pub fn remove_component(&mut self, entity: Entity, component: u32) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        match component {
            1 => self.transforms.remove(entity).is_some(),
            2 => self
                .materials
                .remove(MaterialHandle::from_entity(entity))
                .is_some(),
            3 => self.cameras.remove(entity).is_some(),
            4 => self.mesh_renderers.remove(entity).is_some(),
            5 => self.bounds.remove(entity).is_some(),
            _ => false,
        }
    }

    pub fn set_camera_aspect(&mut self, aspect: f32) {
        if aspect <= 0.0 {
            return;
        }
        for camera in self.cameras.values_mut() {
            camera.aspect = aspect;
        }
    }

    /// Runs allocation-free Phase 1 systems over existing component storage.
    pub fn update(&mut self) {
        update_transforms(&mut self.transforms);
        update_cameras(&mut self.cameras, &self.transforms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn despawn_removes_all_components() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let entity = world.spawn().unwrap();
        assert!(world.add_transform(entity, Transform::default()));
        assert!(world.add_camera(entity, Camera::default()));
        assert!(world.despawn(entity));
        assert!(!world.transforms.contains(entity));
        assert!(!world.cameras.contains(entity));
    }

    #[test]
    fn camera_aspect_updates_without_reinsertion() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let entity = world.spawn().unwrap();
        assert!(world.add_camera(entity, Camera::default()));
        world.set_camera_aspect(16.0 / 9.0);
        assert_eq!(world.cameras.get(entity).unwrap().aspect, 16.0 / 9.0);
    }

    #[test]
    fn component_capacity_rejects_new_components_without_growing() {
        let mut world = World::with_capacity(WorldCapacity {
            entities: 2,
            transforms: 1,
            mesh_renderers: 1,
            cameras: 1,
            materials: 1,
            bounds: 1,
        });
        let first = world.spawn().unwrap();
        let second = world.spawn().unwrap();
        assert!(world.add_camera(first, Camera::default()));
        assert!(!world.add_camera(second, Camera::default()));
        assert_eq!(world.cameras.len(), 1);
    }

    #[test]
    fn mesh_renderer_fails_atomically_when_implicit_bounds_are_full() {
        let mut world = World::with_capacity(WorldCapacity {
            entities: 2,
            transforms: 0,
            mesh_renderers: 1,
            cameras: 0,
            materials: 0,
            bounds: 1,
        });
        let first = world.spawn().unwrap();
        let second = world.spawn().unwrap();
        assert!(world.add_bounds(first, Bounds::default()));
        assert!(!world.add_mesh_renderer(
            second,
            MeshRenderer {
                geometry: 0,
                material: MaterialHandle::from_raw(0),
            },
        ));
        assert!(!world.mesh_renderers.contains(second));
    }
}
