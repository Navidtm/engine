# Roadmap Update Workflow

## Purpose

Keep planned work aligned with implemented facts, accepted architecture, GitHub
tracking, and public documentation.

The internal roadmap is not a feature wishlist. Every near-term milestone must
have an explicit dependency order, ownership boundary, evidence plan, and set of
non-goals.

## Sources of Truth

- `.agents/context/current-state.md` records implemented and verified facts.
- `.agents/context/roadmap.md` owns milestone order, gates, and future intent.
- `docs/roadmap.md` is the concise public roadmap.
- `docs/milestone-<n>.md` owns the detailed plan for an active milestone.
- `.agents/decisions/` owns accepted architectural decisions.
- GitHub issues own actionable implementation units and acceptance criteria.

Never describe planned work as implemented. If these sources disagree,
repository evidence and passing validation determine current state.

## Status Vocabulary

Use these states consistently:

- **Proposed:** ordered in the roadmap, but design gates are not accepted.
- **Designing:** milestone document, ADRs, fixtures, and measurement plan are in
  progress; production implementation must not start.
- **Ready:** required ADRs and entry gates are accepted.
- **In progress:** implementation work has started against accepted scope.
- **Implemented:** production code and regression coverage exist.
- **Measured:** controlled evidence is committed with its environment.
- **Completed:** implementation, evidence, documentation, and exit gates agree.
- **Blocked:** an explicit dependency or unresolved decision prevents progress.

Do not skip from Proposed to In progress.

## Update Process

### 1. Reconcile Evidence

Read the current-state snapshot, roadmap, active milestone document, relevant
ADRs, recent commits, and open/closed GitHub issues. Confirm what is actually
implemented before changing labels or priorities.

### 2. Define Each Near-Term Milestone

Every near-term milestone must state:

- problem and user outcome;
- entry gates and dependencies;
- affected architecture layers;
- resource ownership and lifecycle boundaries;
- deliverables;
- correctness and measurement evidence;
- explicit non-goals; and
- exit gate.

Later milestones may be less detailed, but their dependency order and forbidden
scope must remain clear.

### 3. Check Architecture Order

Reject roadmap ordering that asks a consumer to precede its foundation. For
example:

- materials cannot depend on textures before texture ownership and replay exist;
- general asset composition cannot precede geometry, texture, and material
  lifecycles;
- streaming and cache eviction cannot precede deterministic residency budgets
  and dependency edges; and
- scene import must not introduce a runtime object graph.

### 4. Synchronize Documents

For milestone-order or status changes, update in the same change:

- `.agents/context/roadmap.md`;
- `.agents/context/current-state.md` when implemented facts or current priority
  changed;
- `docs/roadmap.md`; and
- the active `docs/milestone-<n>.md` when detailed scope exists.

Update architecture docs or ADRs only when a decision changed. Do not create an
ADR merely to restate a roadmap preference.

### 5. Synchronize GitHub

Search open and closed issues before creating work. The roadmap change itself
must have a tracking issue. Create implementation issues only after the
milestone scope and acceptance criteria are concrete; do not create speculative
backlog noise.

Every commit implementing tracked roadmap work must reference its issue.

### 6. Review

Use `engine-architect` to verify dependency order and boundaries. Use
`engine-code-reviewer` before completion to check architecture, performance,
standards, and specification consistency. Run formatting checks for all edited
documents.

## Skill Policy

Add a new skill only when all are true:

- a repeated responsibility is not covered by an existing skill or workflow;
- the responsibility has engine-specific rules worth preserving;
- at least two future milestones will use it; and
- its trigger does not overlap ambiguously with an existing skill.

Prefer a workflow for repeatable process and a skill for deep domain judgment.

## Final Gate

A roadmap update is complete only when internal and public plans agree, the
current priority is actionable, future scope is dependency-ordered, and no
planned capability is presented as implemented.
