use core::fmt;

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
}

impl RenderWorld {
    /// Allocates reusable renderer-facing storage with independent capacities.
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, camera_capacity: usize) -> Self {
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
        }
    }

    /// Rebuilds this snapshot from `world` without allocating on success.
    ///
    /// Meshes missing a transform or material are counted and skipped. Capacity
    /// errors leave a partial snapshot which the caller must not submit.
    pub fn extract(&mut self, world: &World) -> Result<ExtractionStats, ExtractionError> {
        self.clear();
        let mut skipped_meshes = 0;

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
            if self.entities.len() == self.entity_capacity || slot >= self.entity_capacity {
                return Err(ExtractionError::InstanceCapacity {
                    capacity: self.entity_capacity,
                });
            }
            self.entities.push(entity.raw());
            self.slots.push(slot as u32);
            self.geometries.push(mesh.geometry);
            self.pipelines.push(material.pipeline.raw());
            self.materials.push(mesh.material.raw());
            let render_revision = world.render_revision(entity);
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
            let local_bounds = world.bounds.get(entity).copied().unwrap_or_default();
            self.bounds
                .push(world_space_bounds(&transform.world_matrix, local_bounds));
        }

        self.build_dirty_ranges();

        for (entity, camera) in world.cameras.iter() {
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

        Ok(ExtractionStats {
            instances: self.entities.len(),
            cameras: self.cameras.len(),
            skipped_meshes,
        })
    }

    /// Clears logical contents while retaining all allocated storage.
    pub fn clear(&mut self) {
        self.entities.clear();
        self.slots.clear();
        self.geometries.clear();
        self.pipelines.clear();
        self.materials.clear();
        self.dirty_slots.clear();
        self.dirty_range_starts.clear();
        self.dirty_range_counts.clear();
        self.bounds.clear();
        self.camera_entities.clear();
        self.cameras.clear();
    }

    /// Returns the maximum number of renderable instances.
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
    use crate::math::Color;
    use crate::{Material, MaterialHandle, MeshRenderer, Transform, WorldCapacity};

    #[test]
    fn extraction_joins_components_into_gpu_layout() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material_entity = world.spawn().unwrap();
        world.add_material(
            material_entity,
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
                geometry: 2,
                material: MaterialHandle::from_entity(material_entity),
            },
        );
        world.update();

        let mut render_world = RenderWorld::with_capacity(4, 1);
        let stats = render_world.extract(&world).unwrap();
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
        assert!(render_world.dirty_range_starts().is_empty());

        world.for_each_transform_mut(|entity, transform| {
            if entity == mesh_entity {
                transform.local_position.0[0] = 2.0;
            }
        });
        world.update();
        render_world.extract(&world).unwrap();
        assert_eq!(
            render_world.dirty_range_starts(),
            &[mesh_entity.index() as u32]
        );

        world.add_material(
            material_entity,
            Material {
                color: Color::new([0.0, 1.0, 0.0, 1.0]),
                ..Material::default()
            },
        );
        render_world.extract(&world).unwrap();
        assert_eq!(
            render_world.dirty_range_starts(),
            &[mesh_entity.index() as u32]
        );
        assert_eq!(
            render_world.instances()[mesh_entity.index()].color.0,
            [0.0, 1.0, 0.0, 1.0]
        );
        assert_eq!(core::mem::size_of::<GpuInstance>(), 80);
        assert_eq!(core::mem::size_of::<GpuCamera>(), 128);
    }

    #[test]
    fn extraction_reports_capacity_instead_of_allocating() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material_entity = world.spawn().unwrap();
        world.add_material(material_entity, Material::default());
        for geometry in 1..=2 {
            let entity = world.spawn().unwrap();
            world.add_transform(entity, Transform::default());
            world.add_mesh_renderer(
                entity,
                MeshRenderer {
                    geometry,
                    material: MaterialHandle::from_entity(material_entity),
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
    fn extraction_coalesces_dirty_slots_and_overwrites_recycled_generations() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material = world.spawn().unwrap();
        world.add_material(material, Material::default());
        let mut meshes = Vec::new();
        for geometry in 1..=3 {
            let entity = world.spawn().unwrap();
            world.add_transform(entity, Transform::default());
            world.add_mesh_renderer(
                entity,
                MeshRenderer {
                    geometry,
                    material: MaterialHandle::from_entity(material),
                },
            );
            meshes.push(entity);
        }
        world.update();
        let mut render_world = RenderWorld::with_capacity(8, 1);
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.dirty_range_starts(), &[1]);
        assert_eq!(render_world.dirty_range_counts(), &[3]);

        let mut moved = Transform::default();
        moved.local_position.0[0] = 2.0;
        world.add_transform(meshes[0], moved);
        world.add_transform(meshes[2], moved);
        world.update();
        render_world.extract(&world).unwrap();
        assert_eq!(render_world.dirty_range_starts(), &[1, 3]);
        assert_eq!(render_world.dirty_range_counts(), &[1, 1]);

        let recycled_slot = meshes[0].index();
        assert!(world.despawn(meshes[0]));
        let recycled = world.spawn().unwrap();
        assert_eq!(recycled.index(), recycled_slot);
        assert_ne!(recycled.generation(), meshes[0].generation());
        world.add_transform(recycled, Transform::default());
        world.add_mesh_renderer(
            recycled,
            MeshRenderer {
                geometry: 7,
                material: MaterialHandle::from_entity(material),
            },
        );
        world.update();
        render_world.extract(&world).unwrap();
        assert!(
            render_world
                .dirty_range_starts()
                .contains(&(recycled_slot as u32))
        );
    }
}
