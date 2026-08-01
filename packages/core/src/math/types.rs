macro_rules! vector_type {
    ($name:ident, $size:expr, $default:expr) => {
        #[derive(Clone, Copy, Debug, PartialEq)]
        #[repr(C)]
        pub struct $name(pub [f32; $size]);

        impl $name {
            #[must_use]
            pub const fn new(values: [f32; $size]) -> Self {
                Self(values)
            }

            #[must_use]
            pub const fn as_array(&self) -> &[f32; $size] {
                &self.0
            }

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

vector_type!(Vec2, 2, [0.0; 2]);
vector_type!(Vec3, 3, [0.0; 3]);
vector_type!(Vec4, 4, [0.0; 4]);
vector_type!(Quat, 4, [0.0, 0.0, 0.0, 1.0]);
vector_type!(Color, 4, [1.0; 4]);

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct Mat4(pub [f32; 16]);

impl Mat4 {
    pub const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

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
