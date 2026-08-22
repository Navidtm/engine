use crate::components::{Bounds, Camera, MeshRenderer, Transform};
use crate::ecs::{Entity, EntityAllocator, SparseSet};
use crate::material::{BasicMaterial, MaterialRegistry};
use crate::resource::MaterialHandle;
use crate::systems::{update_cameras, update_transforms};

/// Independent fixed capacities for entities and each component store.
#[derive(Clone, Copy, Debug)]
pub struct WorldCapacity {
    /// Maximum number of concurrently live entity slots.
    pub entities: usize,
    /// Maximum number of entities with a transform.
    pub transforms: usize,
    /// Maximum number of mesh renderer components.
    pub mesh_renderers: usize,
    /// Maximum number of camera components.
    pub cameras: usize,
    /// Maximum number of basic-material resource mirrors.
    pub materials: usize,
    /// Maximum number of explicit or implicit bounds components.
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

/// Fixed-capacity ECS simulation world.
///
/// `World` owns component storage. Rendering receives only extracted snapshots
/// through [`crate::RenderWorld`], so renderer state never mutates this world.
pub struct World {
    entities: EntityAllocator,
    render_revisions: Vec<u32>,
    render_epoch: u32,
    /// Transform component storage. Mutable access must publish render dirtiness.
    transforms: SparseSet<Transform>,
    /// Mesh renderer component storage.
    mesh_renderers: SparseSet<MeshRenderer>,
    /// Camera component storage.
    pub cameras: SparseSet<Camera>,
    /// Local bounds component storage.
    bounds: SparseSet<Bounds>,
    /// Derived basic-material resource mirror used by extraction.
    materials: MaterialRegistry,
}

impl World {
    /// Constructs a world whose storage will not grow past `capacity`.
    #[must_use]
    pub fn with_capacity(capacity: WorldCapacity) -> Self {
        Self {
            entities: EntityAllocator::with_capacity(capacity.entities),
            render_revisions: vec![0; capacity.entities],
            render_epoch: 1,
            transforms: SparseSet::with_capacity(capacity.entities, capacity.transforms),
            mesh_renderers: SparseSet::with_capacity(capacity.entities, capacity.mesh_renderers),
            cameras: SparseSet::with_capacity(capacity.entities, capacity.cameras),
            bounds: SparseSet::with_capacity(capacity.entities, capacity.bounds),
            materials: MaterialRegistry::with_capacity(capacity.materials),
        }
    }

    /// Allocates an entity, returning `None` when the entity capacity is full.
    pub fn spawn(&mut self) -> Option<Entity> {
        self.entities.spawn()
    }

    /// Claims an externally allocated entity identity for the worker bridge.
    pub fn claim(&mut self, entity: Entity) -> bool {
        self.entities.claim(entity)
    }

    /// Despawns a live entity and removes all of its components atomically.
    pub fn despawn(&mut self, entity: Entity) -> bool {
        let render_dirty = self.transforms.contains(entity)
            || self.mesh_renderers.contains(entity)
            || self.bounds.contains(entity);
        if !self.entities.despawn(entity) {
            return false;
        }
        self.transforms.remove(entity);
        self.mesh_renderers.remove(entity);
        self.cameras.remove(entity);
        self.bounds.remove(entity);
        if render_dirty {
            self.mark_render_dirty();
        }
        true
    }

    /// Returns whether `entity` has a live matching generation.
    #[must_use]
    pub fn is_alive(&self, entity: Entity) -> bool {
        self.entities.is_alive(entity)
    }

    /// Returns the number of currently live entities.
    #[must_use]
    pub fn entity_count(&self) -> usize {
        self.entities.len()
    }

    /// Returns immutable transform storage for allocation-free queries.
    #[must_use]
    pub const fn transforms(&self) -> &SparseSet<Transform> {
        &self.transforms
    }

    /// Returns immutable mesh-renderer storage for allocation-free queries.
    #[must_use]
    pub const fn mesh_renderers(&self) -> &SparseSet<MeshRenderer> {
        &self.mesh_renderers
    }

    /// Returns immutable material storage for allocation-free queries.
    #[must_use]
    pub const fn materials(&self) -> &MaterialRegistry {
        &self.materials
    }

    /// Returns immutable local-bounds storage for allocation-free queries.
    #[must_use]
    pub const fn bounds(&self) -> &SparseSet<Bounds> {
        &self.bounds
    }

    /// Mutates transforms in dense order and marks every visited entity dirty.
    ///
    /// Engine systems must use this entry point instead of retaining mutable
    /// component storage so render extraction cannot miss canonical changes.
    pub fn for_each_transform_mut(&mut self, mut operation: impl FnMut(Entity, &mut Transform)) {
        let (transforms, render_revisions) = (&mut self.transforms, &mut self.render_revisions);
        let mut visited = false;
        for (entity, transform) in transforms.iter_mut() {
            visited = true;
            operation(entity, transform);
            bump_revision(&mut render_revisions[entity.index()]);
        }
        if visited {
            self.mark_render_dirty();
        }
    }

    /// Adds or replaces an entity's transform when capacity and liveness allow it.
    pub fn add_transform(&mut self, entity: Entity, value: Transform) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        let inserted = self.transforms.insert(entity, value).is_ok();
        if inserted {
            bump_revision(&mut self.render_revisions[entity.index()]);
            self.mark_render_dirty();
        }
        inserted
    }

    /// Applies the transport field mask (`position=1`, `rotation=2`, `scale=4`).
    ///
    /// Bit 8 is accepted as a matrix-dirty marker but does not copy matrix data;
    /// the next [`Self::update`] recomputes it from the local fields.
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
        bump_revision(&mut self.render_revisions[entity.index()]);
        self.mark_render_dirty();
        true
    }

    /// Adds or replaces a mesh renderer and ensures default bounds exist.
    ///
    /// The preflight capacity check makes the implicit-bounds addition atomic.
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
        let inserted = mesh_added && bounds_added;
        if inserted {
            bump_revision(&mut self.render_revisions[entity.index()]);
            self.mark_render_dirty();
        }
        inserted
    }

    /// Adds or replaces a camera component.
    pub fn add_camera(&mut self, entity: Entity, value: Camera) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        self.cameras.insert(entity, value).is_ok()
    }

    /// Adds or replaces bounds when the radius is non-negative.
    pub fn add_bounds(&mut self, entity: Entity, value: Bounds) -> bool {
        if !self.is_alive(entity) || value.radius < 0.0 {
            return false;
        }
        let inserted = self.bounds.insert(entity, value).is_ok();
        if inserted {
            self.mark_render_dirty();
        }
        inserted
    }

    /// Adds or replaces a worker-owned basic-material mirror.
    pub fn add_material(&mut self, material: MaterialHandle, value: BasicMaterial) -> bool {
        let inserted = self.materials.insert(material, value).is_ok();
        if inserted {
            for (mesh_entity, mesh) in self.mesh_renderers.iter() {
                if mesh.material == material {
                    bump_revision(&mut self.render_revisions[mesh_entity.index()]);
                }
            }
            self.mark_render_dirty();
        }
        inserted
    }

    /// Removes a matching material generation after its final usage edge is released.
    pub fn remove_material(&mut self, material: MaterialHandle) -> bool {
        if self.materials.remove(material).is_none() {
            return false;
        }
        self.mark_render_dirty();
        true
    }

    /// Removes a component selected by the stable transport component ID.
    ///
    /// IDs are `1=transform`, `2=material`, `3=camera`, `4=mesh renderer`, and
    /// `5=bounds`. Unknown IDs return `false`.
    pub fn remove_component(&mut self, entity: Entity, component: u32) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        let removed = match component {
            1 => self.transforms.remove(entity).is_some(),
            2 => false,
            3 => self.cameras.remove(entity).is_some(),
            4 => self.mesh_renderers.remove(entity).is_some(),
            5 => self.bounds.remove(entity).is_some(),
            _ => false,
        };
        if removed {
            bump_revision(&mut self.render_revisions[entity.index()]);
            if component != 3 {
                self.mark_render_dirty();
            }
        }
        removed
    }

    /// Updates every camera's positive viewport aspect ratio in place.
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

    /// Returns the revision of entity-owned data consumed by render extraction.
    #[must_use]
    pub fn render_revision(&self, entity: Entity) -> u32 {
        self.render_revisions[entity.index()]
    }

    /// Returns the epoch of data consumed by instance and bounds extraction.
    #[must_use]
    pub const fn render_epoch(&self) -> u32 {
        self.render_epoch
    }

    fn mark_render_dirty(&mut self) {
        bump_revision(&mut self.render_epoch);
    }
}

fn bump_revision(revision: &mut u32) {
    *revision = revision.wrapping_add(1);
    if *revision == 0 {
        *revision = 1;
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
                geometry: crate::GeometryHandle::from_raw(0),
                material: MaterialHandle::from_raw(0),
            },
        ));
        assert!(!world.mesh_renderers.contains(second));
    }
}
