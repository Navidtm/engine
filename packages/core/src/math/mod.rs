mod mat4;
mod types;

pub use mat4::{compose, multiply, perspective, view_from_transform};
pub use types::{Color, Mat4, Quat, Vec2, Vec3, Vec4};
