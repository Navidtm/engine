use core::fmt;

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u16 = (1 << (32 - INDEX_BITS)) - 1;

/// A compact entity handle containing a 20-bit index and 12-bit generation.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(transparent)]
pub struct Entity(u32);

impl Entity {
    /// Sentinel raw value that is never allocated by [`EntityAllocator`].
    pub const INVALID: Self = Self(u32::MAX);

    /// Wraps a packed 20-bit-index/12-bit-generation value without validation.
    ///
    /// Use [`Self::from_parts`] when the index and generation are available
    /// separately and should be checked against the packed representation.
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Packs validated index and generation fields, or returns `None` on overflow.
    #[must_use]
    pub const fn from_parts(index: u32, generation: u16) -> Option<Self> {
        if index > INDEX_MASK || generation > MAX_GENERATION {
            return None;
        }
        Some(Self(((generation as u32) << INDEX_BITS) | index))
    }

    /// Returns the transport-ready packed representation.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Returns the sparse-set index portion of the handle.
    #[must_use]
    pub const fn index(self) -> usize {
        (self.0 & INDEX_MASK) as usize
    }

    /// Returns the generation used to reject stale references.
    #[must_use]
    pub const fn generation(self) -> u16 {
        (self.0 >> INDEX_BITS) as u16
    }
}

impl fmt::Debug for Entity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Entity")
            .field("index", &self.index())
            .field("generation", &self.generation())
            .finish()
    }
}

/// Owns entity liveness and generation recycling.
pub struct EntityAllocator {
    capacity: usize,
    generations: Vec<u16>,
    alive: Vec<bool>,
    free: Vec<u32>,
    alive_count: usize,
}

impl EntityAllocator {
    /// Creates a fixed-capacity allocator; allocation never grows past this bound.
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.min((INDEX_MASK as usize) + 1),
            generations: Vec::with_capacity(capacity),
            alive: Vec::with_capacity(capacity),
            free: Vec::with_capacity(capacity),
            alive_count: 0,
        }
    }

    /// Allocates a live entity, reusing a free slot when possible.
    pub fn spawn(&mut self) -> Option<Entity> {
        if let Some(index) = self.free.pop() {
            let index_usize = index as usize;
            self.alive[index_usize] = true;
            self.alive_count += 1;
            return Entity::from_parts(index, self.generations[index_usize]);
        }

        if self.generations.len() >= self.capacity {
            return None;
        }
        let index = u32::try_from(self.generations.len()).ok()?;
        let entity = Entity::from_parts(index, 0)?;
        self.generations.push(0);
        self.alive.push(true);
        self.alive_count += 1;
        Some(entity)
    }

    /// Claims an externally allocated handle. Used by the worker bridge so the
    /// main-thread API can return entity IDs synchronously. Returns false for a
    /// live, stale, or out-of-capacity handle.
    pub fn claim(&mut self, entity: Entity) -> bool {
        let index = entity.index();
        if index > INDEX_MASK as usize || index >= self.capacity {
            return false;
        }
        if index >= self.generations.len() {
            self.generations.resize(index + 1, 0);
            self.alive.resize(index + 1, false);
        }
        if self.alive[index] || self.generations[index] != entity.generation() {
            return false;
        }
        self.alive[index] = true;
        self.alive_count += 1;
        true
    }

    /// Despawns a matching live entity and increments its recycled generation.
    pub fn despawn(&mut self, entity: Entity) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        let index = entity.index();
        self.alive[index] = false;
        self.generations[index] = (self.generations[index] + 1) & MAX_GENERATION;
        self.free.push(index as u32);
        self.alive_count -= 1;
        true
    }

    /// Returns true only when index and generation identify a live slot.
    #[must_use]
    pub fn is_alive(&self, entity: Entity) -> bool {
        self.alive.get(entity.index()).copied().unwrap_or(false)
            && self.generations[entity.index()] == entity.generation()
    }

    /// Number of currently live entities.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.alive_count
    }

    /// Returns whether no entity slots are live.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.alive_count == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_handles_are_rejected_after_recycling() {
        let mut entities = EntityAllocator::with_capacity(2);
        let first = entities.spawn().unwrap();
        assert!(entities.despawn(first));
        let second = entities.spawn().unwrap();
        assert_eq!(first.index(), second.index());
        assert_ne!(first.generation(), second.generation());
        assert!(!entities.is_alive(first));
        assert!(entities.is_alive(second));
    }

    #[test]
    fn exact_handles_can_be_claimed_once() {
        let mut entities = EntityAllocator::with_capacity(4);
        let external = Entity::from_parts(3, 0).unwrap();
        assert!(entities.claim(external));
        assert!(!entities.claim(external));
    }

    #[test]
    fn capacity_is_a_hard_limit() {
        let mut entities = EntityAllocator::with_capacity(1);
        let first = entities.spawn().unwrap();
        assert!(entities.spawn().is_none());
        assert!(!entities.claim(Entity::from_parts(1, 0).unwrap()));
        assert!(entities.despawn(first));
        assert!(entities.spawn().is_some());
    }
}
