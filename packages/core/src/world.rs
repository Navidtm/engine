use crate::components::{Camera, Material, MeshRenderer, Transform};
use crate::ecs::{Entity, EntityAllocator, SparseSet};
use crate::systems::{update_cameras, update_transforms};

#[derive(Clone, Copy, Debug)]
pub struct WorldCapacity {
    pub entities: usize,
    pub transforms: usize,
    pub mesh_renderers: usize,
    pub cameras: usize,
    pub materials: usize,
}

impl Default for WorldCapacity {
    fn default() -> Self {
        Self {
            entities: 4_096,
            transforms: 4_096,
            mesh_renderers: 4_096,
            cameras: 8,
            materials: 256,
        }
    }
}

pub struct World {
    entities: EntityAllocator,
    pub transforms: SparseSet<Transform>,
    pub mesh_renderers: SparseSet<MeshRenderer>,
    pub cameras: SparseSet<Camera>,
    pub materials: SparseSet<Material>,
}

impl World {
    #[must_use]
    pub fn with_capacity(capacity: WorldCapacity) -> Self {
        Self {
            entities: EntityAllocator::with_capacity(capacity.entities),
            transforms: SparseSet::with_capacity(capacity.entities, capacity.transforms),
            mesh_renderers: SparseSet::with_capacity(capacity.entities, capacity.mesh_renderers),
            cameras: SparseSet::with_capacity(capacity.entities, capacity.cameras),
            materials: SparseSet::with_capacity(capacity.entities, capacity.materials),
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
        self.materials.remove(entity);
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
        self.transforms.insert(entity, value);
        true
    }

    pub fn add_mesh_renderer(&mut self, entity: Entity, value: MeshRenderer) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.mesh_renderers.insert(entity, value);
        true
    }

    pub fn add_camera(&mut self, entity: Entity, value: Camera) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.cameras.insert(entity, value);
        true
    }

    pub fn add_material(&mut self, entity: Entity, value: Material) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.materials.insert(entity, value);
        true
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
}
