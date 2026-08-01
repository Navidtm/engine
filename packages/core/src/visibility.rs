use core::fmt;

use crate::math::{Mat4, multiply};
use crate::render_world::{GpuCamera, GpuInstance, RenderWorld};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Plane {
    normal: [f32; 3],
    distance: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frustum {
    planes: [Plane; 6],
}

impl Frustum {
    #[must_use]
    pub fn from_camera(camera: &GpuCamera) -> Self {
        let mut view_projection = Mat4::default();
        multiply(&mut view_projection, &camera.projection, &camera.view);
        Self::from_view_projection(&view_projection)
    }

    #[must_use]
    pub fn from_view_projection(matrix: &Mat4) -> Self {
        let m = &matrix.0;
        let row_0 = [m[0], m[4], m[8], m[12]];
        let row_1 = [m[1], m[5], m[9], m[13]];
        let row_2 = [m[2], m[6], m[10], m[14]];
        let row_3 = [m[3], m[7], m[11], m[15]];
        Self {
            planes: [
                plane_add(row_3, row_0),
                plane_subtract(row_3, row_0),
                plane_add(row_3, row_1),
                plane_subtract(row_3, row_1),
                normalized_plane(row_2),
                plane_subtract(row_3, row_2),
            ],
        }
    }

    #[must_use]
    pub fn intersects_sphere(&self, center: [f32; 3], radius: f32) -> bool {
        self.planes.iter().all(|plane| {
            plane.normal[0] * center[0]
                + plane.normal[1] * center[1]
                + plane.normal[2] * center[2]
                + plane.distance
                >= -radius
        })
    }
}

fn plane_add(left: [f32; 4], right: [f32; 4]) -> Plane {
    normalized_plane([
        left[0] + right[0],
        left[1] + right[1],
        left[2] + right[2],
        left[3] + right[3],
    ])
}

fn plane_subtract(left: [f32; 4], right: [f32; 4]) -> Plane {
    normalized_plane([
        left[0] - right[0],
        left[1] - right[1],
        left[2] - right[2],
        left[3] - right[3],
    ])
}

fn normalized_plane(values: [f32; 4]) -> Plane {
    let inverse_length =
        1.0 / (values[0] * values[0] + values[1] * values[1] + values[2] * values[2]).sqrt();
    Plane {
        normal: [
            values[0] * inverse_length,
            values[1] * inverse_length,
            values[2] * inverse_length,
        ],
        distance: values[3] * inverse_length,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VisibilityStats {
    pub tested: usize,
    pub visible: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VisibilityError {
    pub capacity: usize,
}

impl fmt::Display for VisibilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "VisibleRenderBuffer capacity exceeded ({})",
            self.capacity
        )
    }
}

/// Fixed-capacity, compact renderer input ordered by pipeline/material/mesh.
pub struct VisibleRenderBuffer {
    capacity: usize,
    source_indices: Vec<u32>,
    geometries: Vec<u32>,
    pipelines: Vec<u32>,
    materials: Vec<u32>,
    instances: Vec<GpuInstance>,
}

impl VisibleRenderBuffer {
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            source_indices: Vec::with_capacity(capacity),
            geometries: Vec::with_capacity(capacity),
            pipelines: Vec::with_capacity(capacity),
            materials: Vec::with_capacity(capacity),
            instances: Vec::with_capacity(capacity),
        }
    }

    pub fn cull(&mut self, render_world: &RenderWorld) -> Result<VisibilityStats, VisibilityError> {
        self.clear();
        let frustum = render_world.cameras().first().map(Frustum::from_camera);
        for (index, bounds) in render_world.bounds().iter().enumerate() {
            let [x, y, z, radius] = bounds.center_radius;
            if frustum
                .as_ref()
                .is_none_or(|value| value.intersects_sphere([x, y, z], radius))
            {
                if self.source_indices.len() == self.capacity {
                    return Err(VisibilityError {
                        capacity: self.capacity,
                    });
                }
                self.source_indices.push(index as u32);
            }
        }

        self.source_indices.sort_unstable_by_key(|index| {
            let index = *index as usize;
            (
                render_world.pipelines()[index],
                render_world.materials()[index],
                render_world.geometries()[index],
            )
        });

        for source_index in self.source_indices.iter().copied() {
            let index = source_index as usize;
            self.geometries.push(render_world.geometries()[index]);
            self.pipelines.push(render_world.pipelines()[index]);
            self.materials.push(render_world.materials()[index]);
            self.instances.push(render_world.instances()[index]);
        }

        Ok(VisibilityStats {
            tested: render_world.instances().len(),
            visible: self.instances.len(),
        })
    }

    pub fn clear(&mut self) {
        self.source_indices.clear();
        self.geometries.clear();
        self.pipelines.clear();
        self.materials.clear();
        self.instances.clear();
    }

    #[must_use]
    pub const fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.instances.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.instances.is_empty()
    }

    #[must_use]
    pub fn geometries(&self) -> &[u32] {
        &self.geometries
    }

    #[must_use]
    pub fn pipelines(&self) -> &[u32] {
        &self.pipelines
    }

    #[must_use]
    pub fn materials(&self) -> &[u32] {
        &self.materials
    }

    #[must_use]
    pub fn instances(&self) -> &[GpuInstance] {
        &self.instances
    }

    #[must_use]
    pub fn geometries_capacity_ptr(&self) -> *const u32 {
        self.geometries.as_ptr()
    }

    #[must_use]
    pub fn pipelines_capacity_ptr(&self) -> *const u32 {
        self.pipelines.as_ptr()
    }

    #[must_use]
    pub fn materials_capacity_ptr(&self) -> *const u32 {
        self.materials.as_ptr()
    }

    #[must_use]
    pub fn instances_capacity_ptr(&self) -> *const GpuInstance {
        self.instances.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{Mat4, perspective};
    use crate::{Material, MaterialHandle, MeshRenderer, Transform, World, WorldCapacity};

    #[test]
    fn frustum_intersects_inside_sphere_and_rejects_outside_sphere() {
        let mut projection = Mat4::default();
        perspective(&mut projection, 60.0_f32.to_radians(), 1.0, 0.1, 100.0);
        let frustum = Frustum::from_view_projection(&projection);
        assert!(frustum.intersects_sphere([0.0, 0.0, -5.0], 1.0));
        assert!(!frustum.intersects_sphere([100.0, 0.0, -5.0], 1.0));
        assert!(!frustum.intersects_sphere([0.0, 0.0, 5.0], 1.0));
    }

    #[test]
    fn visible_items_are_compacted_and_grouped() {
        let mut world = World::with_capacity(WorldCapacity::default());
        let first_material = world.spawn().unwrap();
        let second_material = world.spawn().unwrap();
        world.add_material(first_material, Material::default());
        world.add_material(second_material, Material::default());
        for (geometry, material) in [
            (2, second_material),
            (1, first_material),
            (2, first_material),
        ] {
            let entity = world.spawn().unwrap();
            world.add_transform(entity, Transform::default());
            world.add_mesh_renderer(
                entity,
                MeshRenderer {
                    geometry,
                    material: MaterialHandle::from_entity(material),
                },
            );
        }
        world.update();
        let mut render_world = RenderWorld::with_capacity(8, 1);
        render_world.extract(&world).unwrap();
        let mut visible = VisibleRenderBuffer::with_capacity(8);
        let stats = visible.cull(&render_world).unwrap();
        assert_eq!(stats.visible, 3);
        assert_eq!(visible.geometries(), &[1, 2, 2]);
        assert_eq!(
            visible.materials(),
            &[
                first_material.raw(),
                first_material.raw(),
                second_material.raw()
            ]
        );
    }
}
