const RESOURCE_INDEX_MASK: u32 = (1 << 20) - 1;

/// Typed generational key for a built-in geometry resource.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct GeometryHandle(u32);

impl GeometryHandle {
    /// Wraps the packed worker-owned resource representation.
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Returns the complete packed resource key.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// Typed generational key for a basic-material resource.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct MaterialHandle(u32);

impl MaterialHandle {
    /// Wraps the packed worker-owned resource representation.
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Returns the complete packed resource key.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Returns the private registry slot encoded in this key.
    #[must_use]
    pub(crate) const fn index(self) -> usize {
        (self.0 & RESOURCE_INDEX_MASK) as usize
    }

    /// Returns the generation encoded in this key.
    #[must_use]
    pub(crate) const fn generation(self) -> u16 {
        (self.0 >> 20) as u16
    }
}
