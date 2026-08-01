use core::fmt;

use crate::math::{Color, Mat4};
use crate::world::World;

/// Interleaved storage-buffer record: model matrix followed by material color.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct GpuInstance {
    pub world_matrix: Mat4,
    pub color: Color,
}

/// Uniform-buffer record: view matrix followed by projection matrix.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct GpuCamera {
    pub view: Mat4,
    pub projection: Mat4,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtractionStats {
    pub instances: usize,
    pub cameras: usize,
    pub skipped_meshes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractionError {
    InstanceCapacity { capacity: usize },
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
    geometries: Vec<u32>,
    instances: Vec<GpuInstance>,
    camera_entities: Vec<u32>,
    cameras: Vec<GpuCamera>,
}

impl RenderWorld {
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, camera_capacity: usize) -> Self {
        Self {
            entity_capacity,
            camera_capacity,
            entities: Vec::with_capacity(entity_capacity),
            geometries: Vec::with_capacity(entity_capacity),
            instances: Vec::with_capacity(entity_capacity),
            camera_entities: Vec::with_capacity(camera_capacity),
            cameras: Vec::with_capacity(camera_capacity),
        }
    }

    pub fn extract(&mut self, world: &World) -> Result<ExtractionStats, ExtractionError> {
        self.clear();
        let mut skipped_meshes = 0;

        for (entity, mesh) in world.mesh_renderers.iter() {
            let Some(transform) = world.transforms.get(entity) else {
                skipped_meshes += 1;
                continue;
            };
            let Some(material) = world.materials.get(mesh.material) else {
                skipped_meshes += 1;
                continue;
            };
            if self.instances.len() == self.entity_capacity {
                return Err(ExtractionError::InstanceCapacity {
                    capacity: self.entity_capacity,
                });
            }
            self.entities.push(entity.raw());
            self.geometries.push(mesh.geometry);
            self.instances.push(GpuInstance {
                world_matrix: transform.world_matrix,
                color: material.color,
            });
        }

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

        Ok(ExtractionStats {
            instances: self.instances.len(),
            cameras: self.cameras.len(),
            skipped_meshes,
        })
    }

    pub fn clear(&mut self) {
        self.entities.clear();
        self.geometries.clear();
        self.instances.clear();
        self.camera_entities.clear();
        self.cameras.clear();
    }

    #[must_use]
    pub const fn entity_capacity(&self) -> usize {
        self.entity_capacity
    }

    #[must_use]
    pub const fn camera_capacity(&self) -> usize {
        self.camera_capacity
    }

    #[must_use]
    pub fn entities(&self) -> &[u32] {
        &self.entities
    }

    #[must_use]
    pub fn geometries(&self) -> &[u32] {
        &self.geometries
    }

    #[must_use]
    pub fn instances(&self) -> &[GpuInstance] {
        &self.instances
    }

    #[must_use]
    pub fn cameras(&self) -> &[GpuCamera] {
        &self.cameras
    }

    #[must_use]
    pub fn camera_entities(&self) -> &[u32] {
        &self.camera_entities
    }

    #[must_use]
    pub fn entities_capacity_ptr(&self) -> *const u32 {
        self.entities.as_ptr()
    }

    #[must_use]
    pub fn geometries_capacity_ptr(&self) -> *const u32 {
        self.geometries.as_ptr()
    }

    #[must_use]
    pub fn instances_capacity_ptr(&self) -> *const GpuInstance {
        self.instances.as_ptr()
    }

    #[must_use]
    pub fn cameras_capacity_ptr(&self) -> *const GpuCamera {
        self.cameras.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Color;
    use crate::{Material, MeshRenderer, Transform, WorldCapacity};

    #[test]
    fn extraction_joins_components_into_gpu_layout() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let material_entity = world.spawn().unwrap();
        world.add_material(
            material_entity,
            Material {
                color: Color::new([1.0, 0.0, 0.0, 1.0]),
            },
        );
        let mesh_entity = world.spawn().unwrap();
        world.add_transform(mesh_entity, Transform::default());
        world.add_mesh_renderer(
            mesh_entity,
            MeshRenderer {
                geometry: 2,
                material: material_entity,
            },
        );
        world.update();

        let mut render_world = RenderWorld::with_capacity(4, 1);
        let stats = render_world.extract(&world).unwrap();
        assert_eq!(stats.instances, 1);
        assert_eq!(render_world.geometries(), &[2]);
        assert_eq!(render_world.instances()[0].color.0, [1.0, 0.0, 0.0, 1.0]);
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
                    material: material_entity,
                },
            );
        }
        let mut render_world = RenderWorld::with_capacity(1, 1);
        assert_eq!(
            render_world.extract(&world),
            Err(ExtractionError::InstanceCapacity { capacity: 1 })
        );
    }
}
