use core::fmt;

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GENERATION: u16 = (1 << (32 - INDEX_BITS)) - 1;

/// Maximum number of distinct entity indices representable by [`Entity`].
pub const MAX_ENTITY_CAPACITY: usize = (INDEX_MASK as usize) + 1;

/// A compact entity handle containing a 20-bit index and 12-bit generation.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
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
        let raw = ((generation as u32) << INDEX_BITS) | index;
        if raw == Self::INVALID.raw() {
            return None;
        }
        Some(Self(raw))
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

impl Default for Entity {
    fn default() -> Self {
        Self::INVALID
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
        let capacity = capacity.min(MAX_ENTITY_CAPACITY);
        Self {
            capacity,
            generations: Vec::with_capacity(capacity),
            alive: Vec::with_capacity(capacity),
            free: Vec::with_capacity(capacity),
            alive_count: 0,
        }
    }

    /// Allocates a live entity, reusing a free slot when possible.
    pub fn spawn(&mut self) -> Option<Entity> {
        while let Some(index) = self.free.pop() {
            let index_usize = index as usize;
            let Some(entity) = Entity::from_parts(index, self.generations[index_usize]) else {
                // The all-ones sentinel is the only packed field combination
                // that cannot be allocated. Dropping it retires that slot.
                continue;
            };
            self.alive[index_usize] = true;
            self.alive_count += 1;
            return Some(entity);
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
        if entity == Entity::INVALID {
            return false;
        }
        let index = entity.index();
        if index > INDEX_MASK as usize || index >= self.capacity {
            return false;
        }
        if index >= self.generations.len() {
            if entity.generation() != 0 {
                return false;
            }
            let previous_len = self.generations.len();
            self.generations.resize(index + 1, 0);
            self.alive.resize(index + 1, false);
            for vacant in previous_len..index {
                self.free.push(vacant as u32);
            }
        } else {
            if self.alive[index] || self.generations[index] != entity.generation() {
                return false;
            }
            let Some(free_index) = self
                .free
                .iter()
                .rposition(|candidate| *candidate as usize == index)
            else {
                return false;
            };
            self.free.swap_remove(free_index);
        }
        self.alive[index] = true;
        self.alive_count += 1;
        true
    }

    /// Despawns a matching live entity and recycles it while generations remain.
    pub fn despawn(&mut self, entity: Entity) -> bool {
        if !self.is_alive(entity) {
            return false;
        }
        let index = entity.index();
        self.alive[index] = false;
        if self.generations[index] < MAX_GENERATION {
            self.generations[index] += 1;
            if Entity::from_parts(index as u32, self.generations[index]).is_some() {
                self.free.push(index as u32);
            }
        }
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

    /// Maximum number of entity indices this allocator can represent.
    #[must_use]
    pub const fn capacity(&self) -> usize {
        self.capacity
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
    fn generation_exhaustion_retires_a_slot_before_wrap() {
        let mut entities = EntityAllocator::with_capacity(2);
        let retained = entities.spawn().unwrap();
        let mut current = retained;
        for expected_generation in 1..=MAX_GENERATION {
            assert!(entities.despawn(current));
            current = entities.spawn().unwrap();
            assert_eq!(current.index(), retained.index());
            assert_eq!(current.generation(), expected_generation);
        }

        assert!(entities.despawn(current));
        let replacement = entities.spawn().unwrap();
        assert_eq!(replacement.index(), 1);
        assert_eq!(replacement.generation(), 0);
        assert!(!entities.is_alive(retained));
        assert!(!entities.is_alive(current));
    }

    #[test]
    fn exact_handles_can_be_claimed_once() {
        let mut entities = EntityAllocator::with_capacity(4);
        let external = Entity::from_parts(3, 0).unwrap();
        assert!(entities.claim(external));
        assert!(!entities.claim(external));
    }

    #[test]
    fn claiming_a_recycled_slot_removes_it_from_the_free_list() {
        let mut entities = EntityAllocator::with_capacity(2);
        let first = entities.spawn().unwrap();
        assert!(entities.despawn(first));
        let claimed = Entity::from_parts(first.index() as u32, 1).unwrap();
        assert!(entities.claim(claimed));

        let spawned = entities.spawn().unwrap();
        assert_ne!(spawned.index(), claimed.index());
        assert_eq!(entities.len(), 2);
        assert!(entities.is_alive(claimed));
        assert!(entities.is_alive(spawned));
        assert!(entities.spawn().is_none());
    }

    #[test]
    fn sparse_claim_leaves_lower_indices_available() {
        let mut entities = EntityAllocator::with_capacity(4);
        let external = Entity::from_parts(3, 0).unwrap();
        assert!(entities.claim(external));

        let mut spawned = [usize::MAX; 3];
        for slot in &mut spawned {
            *slot = entities.spawn().unwrap().index();
        }
        spawned.sort_unstable();
        assert_eq!(spawned, [0, 1, 2]);
        assert_eq!(entities.len(), 4);
        assert!(entities.spawn().is_none());
    }

    #[test]
    fn default_and_all_ones_entity_are_invalid() {
        assert_eq!(Entity::default(), Entity::INVALID);
        assert_eq!(Entity::from_parts(INDEX_MASK, MAX_GENERATION), None);

        let mut entities = EntityAllocator::with_capacity(MAX_ENTITY_CAPACITY);
        assert!(!entities.claim(Entity::INVALID));
        assert!(entities.is_empty());

        let mut current = Entity::from_parts(INDEX_MASK, 0).unwrap();
        assert!(entities.claim(current));
        for _ in 0..MAX_GENERATION {
            assert!(entities.despawn(current));
            current = entities.spawn().unwrap();
            assert_ne!(current, Entity::INVALID);
        }
        assert_ne!(current.index(), INDEX_MASK as usize);
    }

    #[test]
    fn requested_capacity_is_clamped_before_reserving_storage() {
        let entities = EntityAllocator::with_capacity(usize::MAX);
        assert_eq!(entities.capacity(), MAX_ENTITY_CAPACITY);
        assert_eq!(entities.generations.capacity(), MAX_ENTITY_CAPACITY);
        assert_eq!(entities.alive.capacity(), MAX_ENTITY_CAPACITY);
        assert_eq!(entities.free.capacity(), MAX_ENTITY_CAPACITY);
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
