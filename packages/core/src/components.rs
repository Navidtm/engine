use crate::ecs::Entity;
use crate::math::{Color, Mat4, Quat, Vec3};

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Transform {
    pub local_position: Vec3,
    pub _position_padding: f32,
    pub rotation: Quat,
    pub scale: Vec3,
    pub _scale_padding: f32,
    pub world_matrix: Mat4,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            local_position: Vec3::default(),
            _position_padding: 0.0,
            rotation: Quat::default(),
            scale: Vec3::new([1.0, 1.0, 1.0]),
            _scale_padding: 0.0,
            world_matrix: Mat4::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct MeshRenderer {
    pub geometry: u32,
    pub material: Entity,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Camera {
    pub vertical_fov_radians: f32,
    pub near: f32,
    pub far: f32,
    pub aspect: f32,
    pub view: Mat4,
    pub projection: Mat4,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            vertical_fov_radians: 60.0_f32.to_radians(),
            near: 0.1,
            far: 1_000.0,
            aspect: 1.0,
            view: Mat4::default(),
            projection: Mat4::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C, align(16))]
pub struct Material {
    pub color: Color,
}
