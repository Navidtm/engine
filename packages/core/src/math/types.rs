macro_rules! vector_type {
    ($name:ident, $size:expr, $default:expr, $documentation:literal) => {
        #[doc = $documentation]
        #[derive(Clone, Copy, Debug, PartialEq)]
        #[repr(C)]
        pub struct $name(pub [f32; $size]);

        impl $name {
            /// Creates a tuple from its components in declaration order.
            /// Borrows the components without copying them.
            #[must_use]
            pub const fn new(values: [f32; $size]) -> Self {
                Self(values)
            }

            #[must_use]
            pub const fn as_array(&self) -> &[f32; $size] {
                &self.0
            }

            /// Mutably borrows the components for in-place updates.
            pub fn as_mut_array(&mut self) -> &mut [f32; $size] {
                &mut self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self($default)
            }
        }
    };
}

vector_type!(Vec2, 2, [0.0; 2], "Two-component vector in `[x, y]` order.");
vector_type!(
    Vec3,
    3,
    [0.0; 3],
    "Three-component vector in `[x, y, z]` order."
);
vector_type!(
    Vec4,
    4,
    [0.0; 4],
    "Four-component vector in `[x, y, z, w]` order."
);
vector_type!(
    Quat,
    4,
    [0.0, 0.0, 0.0, 1.0],
    "Rotation quaternion in `[x, y, z, w]` order; the default is identity."
);
vector_type!(
    Color,
    4,
    [1.0; 4],
    "Linear RGBA color in `[red, green, blue, alpha]` order."
);

/// 16-byte-aligned column-major 4×4 matrix compatible with WebGPU layouts.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Mat4(pub [f32; 16]);

impl Mat4 {
    /// Identity matrix.
    pub const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

    /// Borrows the sixteen column-major matrix elements.
    #[must_use]
    pub const fn as_array(&self) -> &[f32; 16] {
        &self.0
    }
}

impl Default for Mat4 {
    fn default() -> Self {
        Self::IDENTITY
    }
}
