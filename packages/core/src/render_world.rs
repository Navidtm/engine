use core::fmt;

use crate::MAX_ENTITY_CAPACITY;
use crate::math::{Color, Mat4};
use crate::world::World;

/// Interleaved storage-buffer record: model matrix followed by material color.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct GpuInstance {
    /// Model-to-world matrix uploaded to instance storage.
    pub world_matrix: Mat4,
    /// Material color paired with this instance.
    pub color: Color,
}

/// Uniform-buffer record: view matrix followed by projection matrix.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct GpuCamera {
    /// World-to-view matrix.
    pub view: Mat4,
    /// View-to-clip projection matrix.
    pub projection: Mat4,
}

/// World-space sphere used only by the visibility stage.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct GpuBounds {
    /// World-space center in `xyz` and conservative radius in `w`.
    pub center_radius: [f32; 4],
}

impl GpuBounds {
    /// Conservative visibility input for renderables without known local bounds.
    pub const UNBOUNDED: Self = Self {
        center_radius: [0.0, 0.0, 0.0, f32::INFINITY],
    };
}

/// Counts produced by one [`RenderWorld::extract`] call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtractionStats {
    /// Number of extracted renderable instances.
    pub instances: usize,
    /// Number of extracted cameras.
    pub cameras: usize,
    /// Meshes skipped because a required transform or material was absent.
    pub skipped_meshes: usize,
}

/// Fixed-capacity extraction failure; no storage is grown to recover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractionError {
    /// Renderable instance capacity was exhausted.
    InstanceCapacity { capacity: usize },
    /// An entity index cannot address the persistent slot storage.
    SlotCapacity { capacity: usize, slot: usize },
    /// Camera capacity was exhausted.
    CameraCapacity { capacity: usize },
}

impl fmt::Display for ExtractionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InstanceCapacity { capacity } => {
                write!(
                    formatter,
                    "RenderWorld instance capacity exceeded ({capacity})"
                )
            }
            Self::SlotCapacity { capacity, slot } => {
                write!(
                    formatter,
                    "RenderWorld slot {slot} exceeds persistent slot capacity ({capacity})"
                )
            }
            Self::CameraCapacity { capacity } => {
                write!(
                    formatter,
                    "RenderWorld camera capacity exceeded ({capacity})"
                )
            }
        }
    }
}

/// Renderer-facing, fixed-capacity snapshot extracted from the simulation world.
pub struct RenderWorld {
    entity_capacity: usize,
    camera_capacity: usize,
    entities: Vec<u32>,
    slots: Vec<u32>,
    geometries: Vec<u32>,
    pipelines: Vec<u32>,
    materials: Vec<u32>,
    instances: Vec<GpuInstance>,
    slot_entities: Vec<u32>,
    slot_render_revisions: Vec<u32>,
    dirty_slots: Vec<u32>,
    dirty_range_starts: Vec<u32>,
    dirty_range_counts: Vec<u32>,
    bounds: Vec<GpuBounds>,
    camera_entities: Vec<u32>,
    cameras: Vec<GpuCamera>,
    previous_cameras: Vec<GpuCamera>,
    cameras_dirty: bool,
    source_epoch: u32,
    snapshot_changed: bool,
    skipped_meshes: usize,
}

impl RenderWorld {
    /// Allocates reusable renderer-facing storage with independent capacities.
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, camera_capacity: usize) -> Self {
        let entity_capacity = entity_capacity.min(MAX_ENTITY_CAPACITY);
        let camera_capacity = camera_capacity.min(MAX_ENTITY_CAPACITY);
        Self {
            entity_capacity,
            camera_capacity,
            entities: Vec::with_capacity(entity_capacity),
            slots: Vec::with_capacity(entity_capacity),
            geometries: Vec::with_capacity(entity_capacity),
            pipelines: Vec::with_capacity(entity_capacity),
            materials: Vec::with_capacity(entity_capacity),
            instances: vec![GpuInstance::default(); entity_capacity],
            slot_entities: vec![u32::MAX; entity_capacity],
            slot_render_revisions: vec![0; entity_capacity],
            dirty_slots: Vec::with_capacity(entity_capacity),
            dirty_range_starts: Vec::with_capacity(entity_capacity),
            dirty_range_counts: Vec::with_capacity(entity_capacity),
            bounds: Vec::with_capacity(entity_capacity),
            camera_entities: Vec::with_capacity(camera_capacity),
            cameras: Vec::with_capacity(camera_capacity),
            previous_cameras: Vec::with_capacity(camera_capacity),
            cameras_dirty: false,
            source_epoch: 0,
            snapshot_changed: false,
            skipped_meshes: 0,
        }
    }

    /// Updates this snapshot from `world`, reusing unchanged instance data.
    ///
    /// Meshes missing a transform or material are counted and skipped. Capacity
    /// errors leave a partial snapshot which the caller must not submit.
    pub fn extract(&mut self, world: &World) -> Result<ExtractionStats, ExtractionError> {
        let source_epoch = world.render_epoch();
        let snapshot_changed = self.source_epoch != source_epoch;
        self.begin_extraction(snapshot_changed);
        let mut skipped_meshes = self.skipped_meshes;

        if snapshot_changed {
            skipped_meshes = 0;
            for (entity, mesh) in world.mesh_renderers().iter() {
                let Some(transform) = world.transforms().get(entity) else {
                    skipped_meshes += 1;
                    continue;
                };
                let Some(material) = world.materials().get(mesh.material) else {
                    skipped_meshes += 1;
                    continue;
                };
                let slot = entity.index();
                if self.entities.len() == self.entity_capacity {
                    return Err(ExtractionError::InstanceCapacity {
                        capacity: self.entity_capacity,
                    });
                }
                if slot >= self.entity_capacity {
                    return Err(ExtractionError::SlotCapacity {
                        capacity: self.entity_capacity,
                        slot,
                    });
                }
                self.entities.push(entity.raw());
                self.slots.push(slot as u32);
                self.geometries.push(mesh.geometry.raw());
                self.pipelines.push(material.pipeline.raw());
                self.materials.push(mesh.material.raw());
                let render_revision = world.render_revision_unchecked(entity);
                if self.slot_entities[slot] != entity.raw()
                    || self.slot_render_revisions[slot] != render_revision
                {
                    self.slot_entities[slot] = entity.raw();
                    self.slot_render_revisions[slot] = render_revision;
                    self.instances[slot] = GpuInstance {
                        world_matrix: transform.world_matrix,
                        color: material.color,
                    };
                    self.dirty_slots.push(slot as u32);
                }
                self.bounds.push(
                    world
                        .bounds()
                        .get(entity)
                        .copied()
                        .map_or(GpuBounds::UNBOUNDED, |local_bounds| {
                            world_space_bounds(&transform.world_matrix, local_bounds)
                        }),
                );
            }

            self.build_dirty_ranges();
        }

        for (entity, camera) in world.cameras().iter() {
            if self.cameras.len() == self.camera_capacity {
                return Err(ExtractionError::CameraCapacity {
                    capacity: self.camera_capacity,
                });
            }
            self.camera_entities.push(entity.raw());
            self.cameras.push(GpuCamera {
                view: camera.view,
                projection: camera.projection,
            });
        }
        self.cameras_dirty = self.cameras != self.previous_cameras;
        self.previous_cameras.clear();
        self.previous_cameras.extend_from_slice(&self.cameras);
        self.source_epoch = source_epoch;
        self.snapshot_changed = snapshot_changed;
        self.skipped_meshes = skipped_meshes;

        Ok(ExtractionStats {
            instances: self.entities.len(),
            cameras: self.cameras.len(),
            skipped_meshes,
        })
    }

    /// Clears logical contents while retaining all allocated storage.
    pub fn clear(&mut self) {
        self.clear_snapshot();
        self.clear_frame_state();
        self.previous_cameras.clear();
        self.cameras_dirty = false;
        self.source_epoch = 0;
        self.snapshot_changed = false;
        self.skipped_meshes = 0;
    }

    fn begin_extraction(&mut self, snapshot_changed: bool) {
        self.snapshot_changed = false;
        self.clear_frame_state();
        if snapshot_changed {
            self.clear_snapshot();
        }
    }

    fn clear_snapshot(&mut self) {
        self.entities.clear();
        self.slots.clear();
        self.geometries.clear();
        self.pipelines.clear();
        self.materials.clear();
        self.bounds.clear();
    }

    fn clear_frame_state(&mut self) {
        self.dirty_slots.clear();
        self.dirty_range_starts.clear();
        self.dirty_range_counts.clear();
        self.camera_entities.clear();
        self.cameras.clear();
    }

    /// Returns both the maximum renderable count and addressable slot count.
    ///
    /// Because persistent instances are entity-indexed, every extracted entity
    /// index must also be lower than this capacity.
    #[must_use]
    pub const fn entity_capacity(&self) -> usize {
        self.entity_capacity
    }

    /// Returns the maximum number of extracted cameras.
    #[must_use]
    pub const fn camera_capacity(&self) -> usize {
        self.camera_capacity
    }

    /// Returns entity IDs in the same order as all instance-side slices.
    #[must_use]
    pub fn entities(&self) -> &[u32] {
        &self.entities
    }

    /// Returns persistent instance-slot indices in extracted instance order.
    #[must_use]
    pub fn slots(&self) -> &[u32] {
        &self.slots
    }

    /// Returns geometry IDs in extracted instance order.
    #[must_use]
    pub fn geometries(&self) -> &[u32] {
        &self.geometries
    }

    /// Returns the complete persistent, entity-indexed GPU instance storage.
    #[must_use]
    pub fn instances(&self) -> &[GpuInstance] {
        &self.instances
    }

    /// Returns the number of renderable instances extracted this frame.
    #[must_use]
    pub fn instance_count(&self) -> usize {
        self.entities.len()
    }

    /// Returns coalesced dirty slot starts for the current extraction.
    #[must_use]
    pub fn dirty_range_starts(&self) -> &[u32] {
        &self.dirty_range_starts
    }

    /// Returns coalesced dirty slot counts matching [`Self::dirty_range_starts`].
    #[must_use]
    pub fn dirty_range_counts(&self) -> &[u32] {
        &self.dirty_range_counts
    }

    /// Returns pipeline IDs in extracted instance order.
    #[must_use]
    pub fn pipelines(&self) -> &[u32] {
        &self.pipelines
    }

    /// Returns material handles in extracted instance order.
    #[must_use]
    pub fn materials(&self) -> &[u32] {
        &self.materials
    }

    /// Returns world-space bounds in extracted instance order.
    #[must_use]
    pub fn bounds(&self) -> &[GpuBounds] {
        &self.bounds
    }

    /// Returns camera records in extracted camera order.
    #[must_use]
    pub fn cameras(&self) -> &[GpuCamera] {
        &self.cameras
    }

    /// Returns whether extracted camera records changed this frame.
    #[must_use]
    pub const fn cameras_dirty(&self) -> bool {
        self.cameras_dirty
    }

    /// Returns whether instance metadata or bounds were rebuilt this frame.
    #[must_use]
    pub const fn snapshot_changed(&self) -> bool {
        self.snapshot_changed
    }

    /// Returns entity IDs that own the returned [`Self::cameras`].
    #[must_use]
    pub fn camera_entities(&self) -> &[u32] {
        &self.camera_entities
    }

    /// Returns the stable allocation pointer for entity IDs.
    ///
    /// The pointer stays valid until this `RenderWorld` is dropped because
    /// extraction never grows the vector beyond its configured capacity.
    #[must_use]
    pub fn entities_capacity_ptr(&self) -> *const u32 {
        self.entities.as_ptr()
    }

    /// Returns the stable allocation pointer for geometry IDs.
    #[must_use]
    pub fn geometries_capacity_ptr(&self) -> *const u32 {
        self.geometries.as_ptr()
    }

    /// Returns the stable allocation pointer for GPU instances.
    #[must_use]
    pub fn instances_capacity_ptr(&self) -> *const GpuInstance {
        self.instances.as_ptr()
    }

    /// Returns the stable pointer to dirty range starts.
    #[must_use]
    pub fn dirty_range_starts_capacity_ptr(&self) -> *const u32 {
        self.dirty_range_starts.as_ptr()
    }

    /// Returns the stable pointer to dirty range counts.
    #[must_use]
    pub fn dirty_range_counts_capacity_ptr(&self) -> *const u32 {
        self.dirty_range_counts.as_ptr()
    }

    fn build_dirty_ranges(&mut self) {
        self.dirty_slots.sort_unstable();
        for slot in self.dirty_slots.iter().copied() {
            if let (Some(start), Some(count)) = (
                self.dirty_range_starts.last().copied(),
                self.dirty_range_counts.last_mut(),
            ) {
                if slot == start + *count {
                    *count += 1;
                    continue;
                }
            }
            self.dirty_range_starts.push(slot);
            self.dirty_range_counts.push(1);
        }
    }

    /// Returns the stable allocation pointer for GPU cameras.
    #[must_use]
    pub fn cameras_capacity_ptr(&self) -> *const GpuCamera {
        self.cameras.as_ptr()
    }
}

fn world_space_bounds(matrix: &Mat4, bounds: crate::Bounds) -> GpuBounds {
    let values = &matrix.0;
    let [x, y, z] = bounds.center.0;
    let center = [
        values[0] * x + values[4] * y + values[8] * z + values[12],
        values[1] * x + values[5] * y + values[9] * z + values[13],
        values[2] * x + values[6] * y + values[10] * z + values[14],
    ];
    let scale_x = (values[0] * values[0] + values[1] * values[1] + values[2] * values[2]).sqrt();
    let scale_y = (values[4] * values[4] + values[5] * values[5] + values[6] * values[6]).sqrt();
    let scale_z = (values[8] * values[8] + values[9] * values[9] + values[10] * values[10]).sqrt();
    GpuBounds {
        center_radius: [
            center[0],
            center[1],
            center[2],
            bounds.radius * scale_x.max(scale_y).max(scale_z),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{Color, Vec3};
    use crate::{Bounds, Entity, Material, MaterialHandle, MeshRenderer, Transform, WorldCapacity};

    #[test]
    fn extraction_joins_components_into_gpu_layout() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = MaterialHandle::from_raw(1);
        world.add_material(
            material,
            Material {
                color: Color::new([1.0, 0.0, 0.0, 1.0]),
                ..Material::default()
            },
        );
        let mesh_entity = world.spawn().unwrap();
        world.add_transform(mesh_entity, Transform::default());
        world.add_mesh_renderer(
            mesh_entity,
            MeshRenderer {
                geometry: crate::GeometryHandle::from_raw(2),
                material,
            },
        );
        world.update();

        let mut render_world = RenderWorld::with_capacity(4, 1);
        let stats = render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(stats.instances, 1);
        assert_eq!(render_world.geometries(), &[2]);
        assert_eq!(
            render_world.instances()[mesh_entity.index()].color.0,
            [1.0, 0.0, 0.0, 1.0]
        );
        assert_eq!(render_world.slots(), &[mesh_entity.index() as u32]);
        assert_eq!(
            render_world.dirty_range_starts(),
            &[mesh_entity.index() as u32]
        );
        assert_eq!(render_world.dirty_range_counts(), &[1]);
        render_world.extract(&world).unwrap();
        assert!(!render_world.snapshot_changed());
        assert!(render_world.dirty_range_starts().is_empty());

        world.for_each_transform_mut(|entity, transform| {
            if entity == mesh_entity {
                transform.local_position.0[0] = 2.0;
            }
        });
        world.update();
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(
            render_world.dirty_range_starts(),
            &[mesh_entity.index() as u32]
        );

        world.add_material(
            material,
            Material {
                color: Color::new([0.0, 1.0, 0.0, 1.0]),
                ..Material::default()
            },
        );
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(
            render_world.dirty_range_starts(),
            &[mesh_entity.index() as u32]
        );
        assert_eq!(
            render_world.instances()[mesh_entity.index()].color.0,
            [0.0, 1.0, 0.0, 1.0]
        );

        world.add_bounds(
            mesh_entity,
            Bounds {
                center: Vec3::default(),
                radius: 2.0,
            },
        );
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(render_world.bounds()[0].center_radius[3], 2.0);
        assert_eq!(core::mem::size_of::<GpuInstance>(), 80);
        assert_eq!(core::mem::size_of::<GpuCamera>(), 128);
    }

    #[test]
    fn extraction_reports_capacity_instead_of_allocating() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = MaterialHandle::from_raw(1);
        world.add_material(material, Material::default());
        for geometry in 1..=2 {
            let entity = world.spawn().unwrap();
            world.add_transform(entity, Transform::default());
            world.add_mesh_renderer(
                entity,
                MeshRenderer {
                    geometry: crate::GeometryHandle::from_raw(geometry),
                    material,
                },
            );
        }
        let mut render_world = RenderWorld::with_capacity(1, 1);
        assert_eq!(
            render_world.extract(&world),
            Err(ExtractionError::InstanceCapacity { capacity: 1 })
        );
    }

    #[test]
    fn extraction_distinguishes_persistent_slot_capacity() {
        let mut world = World::with_capacity(WorldCapacity {
            entities: 101,
            transforms: 1,
            mesh_renderers: 1,
            cameras: 0,
            materials: 2,
            bounds: 0,
        });
        let material = MaterialHandle::from_raw(1);
        assert!(world.add_material(material, Material::default()));
        let entity = Entity::from_parts(100, 0).unwrap();
        assert!(world.claim(entity));
        assert!(world.add_transform(entity, Transform::default()));
        assert!(world.add_mesh_renderer(
            entity,
            MeshRenderer {
                geometry: crate::GeometryHandle::from_raw(1),
                material,
            },
        ));

        let mut render_world = RenderWorld::with_capacity(10, 0);
        assert_eq!(
            render_world.extract(&world),
            Err(ExtractionError::SlotCapacity {
                capacity: 10,
                slot: 100,
            })
        );
    }

    #[test]
    fn missing_or_removed_bounds_are_conservatively_unbounded() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = MaterialHandle::from_raw(1);
        assert!(world.add_material(material, Material::default()));
        let entity = world.spawn().unwrap();
        assert!(world.add_transform(entity, Transform::default()));
        assert!(world.add_mesh_renderer(
            entity,
            MeshRenderer {
                geometry: crate::GeometryHandle::from_raw(1),
                material,
            },
        ));
        world.update();

        let mut render_world = RenderWorld::with_capacity(4, 0);
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.bounds(), &[GpuBounds::UNBOUNDED]);

        assert!(world.add_bounds(
            entity,
            Bounds {
                center: Vec3::default(),
                radius: 2.0,
            },
        ));
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.bounds()[0].center_radius[3], 2.0);

        assert!(world.remove_component(entity, 5));
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.bounds(), &[GpuBounds::UNBOUNDED]);
    }

    #[test]
    fn update_after_early_extraction_republishes_the_derived_matrix() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = MaterialHandle::from_raw(1);
        assert!(world.add_material(material, Material::default()));
        let entity = world.spawn().unwrap();
        assert!(world.add_transform(entity, Transform::default()));
        assert!(world.add_mesh_renderer(
            entity,
            MeshRenderer {
                geometry: crate::GeometryHandle::from_raw(1),
                material,
            },
        ));
        world.update();
        let mut render_world = RenderWorld::with_capacity(4, 0);
        render_world.extract(&world).unwrap();

        world.for_each_transform_mut(|candidate, transform| {
            if candidate == entity {
                transform.local_position.0[0] = 3.0;
            }
        });
        render_world.extract(&world).unwrap();
        assert_eq!(
            render_world.instances()[entity.index()].world_matrix.0[12],
            0.0
        );

        world.update();
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(
            render_world.instances()[entity.index()].world_matrix.0[12],
            3.0
        );
        assert_eq!(render_world.dirty_range_starts(), &[entity.index() as u32]);
    }

    #[test]
    fn extraction_coalesces_dirty_slots_and_overwrites_recycled_generations() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = MaterialHandle::from_raw(1);
        world.add_material(material, Material::default());
        let mut meshes = Vec::new();
        for geometry in 1..=3 {
            let entity = world.spawn().unwrap();
            world.add_transform(entity, Transform::default());
            world.add_mesh_renderer(
                entity,
                MeshRenderer {
                    geometry: crate::GeometryHandle::from_raw(geometry),
                    material,
                },
            );
            meshes.push(entity);
        }
        world.update();
        let mut render_world = RenderWorld::with_capacity(8, 1);
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.dirty_range_starts(), &[0]);
        assert_eq!(render_world.dirty_range_counts(), &[3]);

        let mut moved = Transform::default();
        moved.local_position.0[0] = 2.0;
        world.add_transform(meshes[0], moved);
        world.add_transform(meshes[2], moved);
        world.update();
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.dirty_range_starts(), &[0, 2]);
        assert_eq!(render_world.dirty_range_counts(), &[1, 1]);

        let recycled_slot = meshes[0].index();
        assert!(world.despawn(meshes[0]));
        assert!(!world.add_transform(meshes[0], Transform::default()));
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(render_world.instance_count(), 2);

        let recycled = world.spawn().unwrap();
        assert_eq!(recycled.index(), recycled_slot);
        assert_ne!(recycled.generation(), meshes[0].generation());
        world.add_transform(recycled, Transform::default());
        world.add_mesh_renderer(
            recycled,
            MeshRenderer {
                geometry: crate::GeometryHandle::from_raw(7),
                material,
            },
        );
        world.update();
        render_world.extract(&world).unwrap();
        assert!(render_world.snapshot_changed());
        assert_eq!(render_world.instance_count(), 3);
        assert!(
            render_world
                .dirty_range_starts()
                .contains(&(recycled_slot as u32))
        );
    }
}
