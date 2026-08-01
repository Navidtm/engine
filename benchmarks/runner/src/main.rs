use std::alloc::{GlobalAlloc, Layout, System};
use std::fmt::Write as _;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use lume_core::math::{Color, Vec3};
use lume_core::{
    Bounds, Camera, Material, MaterialHandle, MeshRenderer, RenderWorld, Transform,
    VisibleRenderBuffer, World, WorldCapacity,
};

struct CountingAllocator;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every operation delegates to the system allocator without changing
// pointer/layout contracts. The atomics are diagnostic side effects only.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: delegated with the original layout.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: delegated with the original pointer and layout.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: delegated with the original pointer/layout and requested size.
        let result = unsafe { System.realloc(pointer, layout, new_size) };
        if !result.is_null() {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            ALLOCATED_BYTES.fetch_add(new_size, Ordering::Relaxed);
        }
        result
    }
}

#[global_allocator]
static GLOBAL: CountingAllocator = CountingAllocator;

#[derive(Clone, Copy)]
struct Sample {
    duration_ms: f64,
    allocations: usize,
    allocated_bytes: usize,
}

struct ResultRecord {
    scenario: &'static str,
    entities: usize,
    samples_ms: Vec<f64>,
    allocations: usize,
    allocated_bytes: usize,
    estimated_memory_bytes: usize,
    visible_count: Option<usize>,
    frame_preparation_samples_ms: Vec<f64>,
}

fn main() {
    let output = output_path();
    let mut results = Vec::with_capacity(64);
    const SCALE_COUNTS: [usize; 6] = [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];

    for count in SCALE_COUNTS {
        results.push(benchmark_entity_creation(count));
    }
    for count in SCALE_COUNTS {
        results.extend(benchmark_component_storage(count));
    }
    for count in SCALE_COUNTS {
        results.push(benchmark_transform_system(count));
    }
    for count in SCALE_COUNTS {
        results.push(benchmark_render_extraction(count));
    }
    for (scenario, visible_percent) in [
        ("frustum_culling_100_percent", 100),
        ("frustum_culling_50_percent", 50),
        ("frustum_culling_10_percent", 10),
        ("frustum_culling_1_percent", 1),
    ] {
        results.push(benchmark_frustum_culling(scenario, visible_percent));
    }

    let report = render_json(&results);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("create benchmark results directory");
    }
    fs::write(&output, report).expect("write benchmark JSON");
    println!(
        "wrote {} benchmark records to {}",
        results.len(),
        output.display()
    );
}

fn output_path() -> PathBuf {
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--output" {
            return PathBuf::from(arguments.next().expect("--output requires a path"));
        }
    }
    PathBuf::from("benchmarks/results/internal-latest.json")
}

fn capacity(count: usize) -> WorldCapacity {
    WorldCapacity {
        entities: count,
        transforms: count,
        mesh_renderers: count,
        cameras: 1,
        materials: 1,
        bounds: count,
    }
}

fn reset_allocator() {
    ALLOCATIONS.store(0, Ordering::SeqCst);
    ALLOCATED_BYTES.store(0, Ordering::SeqCst);
}

fn measure<T>(operation: impl FnOnce() -> T) -> (T, Sample) {
    reset_allocator();
    let started = Instant::now();
    let value = operation();
    let duration_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let sample = Sample {
        duration_ms,
        allocations: ALLOCATIONS.load(Ordering::SeqCst),
        allocated_bytes: ALLOCATED_BYTES.load(Ordering::SeqCst),
    };
    (value, sample)
}

fn benchmark_entity_creation(count: usize) -> ResultRecord {
    let (world, sample) = measure(|| {
        let mut world = World::with_capacity(capacity(count));
        for _ in 0..count {
            black_box(world.spawn().expect("entity capacity"));
        }
        world
    });
    black_box(&world);
    ResultRecord {
        scenario: "ecs_entity_creation",
        entities: count,
        samples_ms: vec![sample.duration_ms],
        allocations: sample.allocations,
        allocated_bytes: sample.allocated_bytes,
        estimated_memory_bytes: sample.allocated_bytes,
        visible_count: None,
        frame_preparation_samples_ms: Vec::new(),
    }
}

fn prepared_transform_world(count: usize) -> (World, Vec<lume_core::Entity>) {
    let mut world = World::with_capacity(capacity(count));
    let mut entities = Vec::with_capacity(count);
    for _ in 0..count {
        entities.push(world.spawn().expect("entity capacity"));
    }
    (world, entities)
}

fn benchmark_component_storage(count: usize) -> Vec<ResultRecord> {
    let (mut world, entities) = prepared_transform_world(count);
    let (_, insert) = measure(|| {
        for entity in &entities {
            black_box(world.add_transform(*entity, Transform::default()));
        }
    });
    let (_, iteration) = measure(|| {
        let mut sum = 0.0;
        for transform in world.transforms.values() {
            sum += transform.local_position.0[0];
        }
        black_box(sum);
    });
    let (_, query) = measure(|| {
        let mut found = 0;
        for entity in &entities {
            found += usize::from(world.transforms.get(*entity).is_some());
        }
        black_box(found);
    });
    let memory = count * std::mem::size_of::<Transform>();
    vec![
        record("transform_insertion", count, insert, memory),
        record("transform_iteration", count, iteration, memory),
        record("transform_query", count, query, memory),
    ]
}

fn benchmark_transform_system(count: usize) -> ResultRecord {
    let (mut world, entities) = prepared_transform_world(count);
    for entity in entities {
        world.add_transform(entity, Transform::default());
    }
    let mut samples = Vec::with_capacity(30);
    let mut max_allocations = 0;
    let mut allocated_bytes = 0;
    for _ in 0..30 {
        let (_, sample) = measure(|| {
            for transform in world.transforms.values_mut() {
                transform.local_position.0[0] += 0.001;
            }
            world.update();
            black_box(world.transforms.values());
        });
        samples.push(sample.duration_ms);
        max_allocations = max_allocations.max(sample.allocations);
        allocated_bytes = allocated_bytes.max(sample.allocated_bytes);
    }
    ResultRecord {
        scenario: "transform_system_update",
        entities: count,
        samples_ms: samples,
        allocations: max_allocations,
        allocated_bytes,
        estimated_memory_bytes: count * std::mem::size_of::<Transform>(),
        visible_count: None,
        frame_preparation_samples_ms: Vec::new(),
    }
}

fn benchmark_render_extraction(count: usize) -> ResultRecord {
    let mut world = World::with_capacity(capacity(count + 1));
    let material_entity = world.spawn().expect("material entity");
    world.add_material(
        material_entity,
        Material {
            color: Color::new([0.3, 0.6, 1.0, 1.0]),
            ..Material::default()
        },
    );
    for _ in 0..count {
        let entity = world.spawn().expect("mesh entity");
        world.add_transform(entity, Transform::default());
        world.add_mesh_renderer(
            entity,
            MeshRenderer {
                geometry: 2,
                material: MaterialHandle::from_entity(material_entity),
            },
        );
    }
    world.update();
    let mut render_world = RenderWorld::with_capacity(count, 1);
    let mut samples = Vec::with_capacity(30);
    let mut max_allocations = 0;
    let mut allocated_bytes = 0;
    for _ in 0..30 {
        let (_, sample) = measure(|| {
            black_box(render_world.extract(&world).expect("render capacity"));
        });
        samples.push(sample.duration_ms);
        max_allocations = max_allocations.max(sample.allocations);
        allocated_bytes = allocated_bytes.max(sample.allocated_bytes);
    }
    ResultRecord {
        scenario: "render_world_extraction",
        entities: count,
        samples_ms: samples,
        allocations: max_allocations,
        allocated_bytes,
        estimated_memory_bytes: count * (std::mem::size_of::<lume_core::GpuInstance>() + 8),
        visible_count: None,
        frame_preparation_samples_ms: Vec::new(),
    }
}

fn benchmark_frustum_culling(scenario: &'static str, visible_percent: usize) -> ResultRecord {
    const COUNT: usize = 100_000;
    let mut world = World::with_capacity(capacity(COUNT + 2));
    let material_entity = world.spawn().expect("material entity");
    world.add_material(material_entity, Material::default());
    let camera_entity = world.spawn().expect("camera entity");
    world.add_transform(camera_entity, Transform::default());
    world.add_camera(
        camera_entity,
        Camera {
            vertical_fov_radians: 60.0_f32.to_radians(),
            near: 0.1,
            far: 100.0,
            aspect: 1.0,
            ..Camera::default()
        },
    );
    let expected_visible = COUNT * visible_percent / 100;
    for index in 0..COUNT {
        let entity = world.spawn().expect("mesh entity");
        let x = if index < expected_visible {
            0.0
        } else {
            10_000.0
        };
        world.add_transform(
            entity,
            Transform {
                local_position: Vec3::new([x, 0.0, -10.0]),
                ..Transform::default()
            },
        );
        world.add_mesh_renderer(
            entity,
            MeshRenderer {
                geometry: 2,
                material: MaterialHandle::from_entity(material_entity),
            },
        );
        world.add_bounds(
            entity,
            Bounds {
                center: Vec3::default(),
                radius: 0.5,
            },
        );
    }
    world.update();
    let mut render_world = RenderWorld::with_capacity(COUNT, 1);
    render_world.extract(&world).expect("render capacity");
    let mut visible = VisibleRenderBuffer::with_capacity(COUNT);
    visible.cull(&render_world).expect("visible capacity");
    assert_eq!(visible.len(), expected_visible);

    let mut samples = Vec::with_capacity(30);
    let mut frame_preparation_samples = Vec::with_capacity(30);
    let mut max_allocations = 0;
    let mut allocated_bytes = 0;
    for _ in 0..30 {
        let (_, culling) = measure(|| {
            black_box(visible.cull(&render_world).expect("visible capacity"));
        });
        samples.push(culling.duration_ms);
        max_allocations = max_allocations.max(culling.allocations);
        allocated_bytes = allocated_bytes.max(culling.allocated_bytes);

        let (_, preparation) = measure(|| {
            world.update();
            render_world.extract(&world).expect("render capacity");
            black_box(visible.cull(&render_world).expect("visible capacity"));
        });
        frame_preparation_samples.push(preparation.duration_ms);
        max_allocations = max_allocations.max(preparation.allocations);
        allocated_bytes = allocated_bytes.max(preparation.allocated_bytes);
    }
    ResultRecord {
        scenario,
        entities: COUNT,
        samples_ms: samples,
        allocations: max_allocations,
        allocated_bytes,
        estimated_memory_bytes: COUNT
            * (std::mem::size_of::<lume_core::GpuInstance>()
                + std::mem::size_of::<lume_core::GpuBounds>()
                + 4 * std::mem::size_of::<u32>()),
        visible_count: Some(expected_visible),
        frame_preparation_samples_ms: frame_preparation_samples,
    }
}

fn record(
    scenario: &'static str,
    entities: usize,
    sample: Sample,
    estimated_memory_bytes: usize,
) -> ResultRecord {
    ResultRecord {
        scenario,
        entities,
        samples_ms: vec![sample.duration_ms],
        allocations: sample.allocations,
        allocated_bytes: sample.allocated_bytes,
        estimated_memory_bytes,
        visible_count: None,
        frame_preparation_samples_ms: Vec::new(),
    }
}

fn render_json(results: &[ResultRecord]) -> String {
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let cpu = cpu_name().replace('"', "'");
    let mut output = format!(
        "{{\n  \"schemaVersion\": 1,\n  \"generatedAtUnixMs\": {generated_at},\n  \"engine\": {{ \"name\": \"lume\", \"version\": \"0.2.0\" }},\n  \"hardware\": {{ \"os\": \"{}\", \"arch\": \"{}\", \"cpu\": \"{}\" }},\n  \"configuration\": {{ \"profile\": \"release\", \"threading\": \"single-thread\" }},\n  \"results\": [\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        cpu,
    );
    for (index, result) in results.iter().enumerate() {
        let mean = result.samples_ms.iter().sum::<f64>() / result.samples_ms.len() as f64;
        let throughput = if mean > 0.0 {
            result.entities as f64 / (mean / 1_000.0)
        } else {
            0.0
        };
        write!(
            output,
            "    {{ \"scenario\": \"{}\", \"entities\": {}, \"visibleCount\": {}, \"meanMs\": {:.6}, \"throughputPerSecond\": {:.3}, \"allocations\": {}, \"allocatedBytes\": {}, \"estimatedMemoryBytes\": {}, \"samplesMs\": [",
            result.scenario,
            result.entities,
            result.visible_count.map_or_else(|| "null".to_owned(), |value| value.to_string()),
            mean,
            throughput,
            result.allocations,
            result.allocated_bytes,
            result.estimated_memory_bytes,
        )
        .expect("write JSON");
        for (sample_index, sample) in result.samples_ms.iter().enumerate() {
            if sample_index > 0 {
                output.push_str(", ");
            }
            write!(output, "{sample:.6}").expect("write sample");
        }
        output.push_str("], \"framePreparationSamplesMs\": [");
        for (sample_index, sample) in result.frame_preparation_samples_ms.iter().enumerate() {
            if sample_index > 0 {
                output.push_str(", ");
            }
            write!(output, "{sample:.6}").expect("write preparation sample");
        }
        output.push_str("] }");
        if index + 1 != results.len() {
            output.push(',');
        }
        output.push('\n');
    }
    output.push_str("  ]\n}\n");
    output
}

fn cpu_name() -> String {
    if cfg!(target_os = "macos") {
        for key in ["machdep.cpu.brand_string", "hw.model"] {
            if let Ok(output) = Command::new("sysctl").args(["-n", key]).output() {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !value.is_empty() {
                    return value;
                }
            }
        }
    }
    std::env::var("PROCESSOR_IDENTIFIER")
        .unwrap_or_else(|_| format!("{} {}", std::env::consts::OS, std::env::consts::ARCH))
}
