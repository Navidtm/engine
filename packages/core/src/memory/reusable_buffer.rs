/// Fixed-capacity scratch storage whose backing allocation is reused per frame.
pub struct ReusableBuffer<T: Copy + Default> {
    storage: Vec<T>,
    len: usize,
}

impl<T: Copy + Default> ReusableBuffer<T> {
    /// Allocates fixed-capacity storage initialized with `T::default()`.
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            storage: vec![T::default(); capacity],
            len: 0,
        }
    }

    /// Clears logical contents while retaining every initialized slot.
    pub fn reset(&mut self) {
        self.len = 0;
    }

    /// Appends `value`, or returns it unchanged when capacity is exhausted.
    pub fn push(&mut self, value: T) -> Result<(), T> {
        let Some(slot) = self.storage.get_mut(self.len) else {
            return Err(value);
        };
        *slot = value;
        self.len += 1;
        Ok(())
    }

    /// Borrows only the initialized prefix of the backing allocation.
    #[must_use]
    pub fn as_slice(&self) -> &[T] {
        &self.storage[..self.len]
    }

    /// Returns the number of initialized values.
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Returns whether no initialized value is stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns the immutable backing capacity.
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.storage.len()
    }
}
