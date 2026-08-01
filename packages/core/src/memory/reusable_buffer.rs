/// Fixed-capacity scratch storage whose backing allocation is reused per frame.
pub struct ReusableBuffer<T: Copy + Default> {
    storage: Vec<T>,
    len: usize,
}

impl<T: Copy + Default> ReusableBuffer<T> {
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            storage: vec![T::default(); capacity],
            len: 0,
        }
    }

    pub fn reset(&mut self) {
        self.len = 0;
    }

    pub fn push(&mut self, value: T) -> Result<(), T> {
        let Some(slot) = self.storage.get_mut(self.len) else {
            return Err(value);
        };
        *slot = value;
        self.len += 1;
        Ok(())
    }

    #[must_use]
    pub fn as_slice(&self) -> &[T] {
        &self.storage[..self.len]
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.storage.len()
    }
}
