use crate::material::MaterialHandle;
use crate::math::{Mat4, Quat, Vec3};

/// Local transform and cached world matrix stored by the ECS.
///
/// The explicit padding keeps this record compatible with the GPU-facing
/// extraction layout. [`crate::systems::update_transforms`] refreshes
/// [`Self::world_matrix`] from the local fields.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Transform {
    /// Translation relative to the world origin, in engine units.
    pub local_position: Vec3,
    /// Padding reserved for 16-byte alignment; callers must leave it at zero.
    pub _position_padding: f32,
    /// Unit quaternion in `[x, y, z, w]` order.
    pub rotation: Quat,
    /// Per-axis local scale.
    pub scale: Vec3,
    /// Padding reserved for 16-byte alignment; callers must leave it at zero.
    pub _scale_padding: f32,
    /// Derived matrix consumed by rendering and bounds extraction.
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

/// Selects a geometry and material for an entity rendered as a mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct MeshRenderer {
    /// Application-defined geometry identifier resolved by the renderer.
    pub geometry: u32,
    /// Handle of the material component to use for this mesh.
    pub material: MaterialHandle,
}

/// Local-space bounding sphere used for visibility testing.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Bounds {
    /// Sphere center in the mesh's local space.
    pub center: Vec3,
    /// Non-negative sphere radius in engine units.
    pub radius: f32,
}

impl Bounds {
    /// Bounds that enclose a unit cube centered at the origin.
    pub const UNIT_CUBE: Self = Self {
        center: Vec3::new([0.0, 0.0, 0.0]),
        radius: 0.866_025_4,
    };
}

impl Default for Bounds {
    fn default() -> Self {
        Self::UNIT_CUBE
    }
}

/// Perspective camera parameters and derived view/projection matrices.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Camera {
    /// Vertical field of view, in radians.
    pub vertical_fov_radians: f32,
    /// Positive distance to the near clipping plane.
    pub near: f32,
    /// Distance to the far clipping plane, greater than [`Self::near`].
    pub far: f32,
    /// Width divided by height of the render surface.
    pub aspect: f32,
    /// Derived inverse transform used by the renderer.
    pub view: Mat4,
    /// Derived perspective projection used by the renderer.
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
