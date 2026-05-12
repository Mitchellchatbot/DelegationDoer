// Project templates. Each template seeds a project with an ordered
// list of stages and (optional) draft tasks per stage. The software
// template captures the most common DD ship pipeline:
//   1. Initial scope — write down what we're building and why
//   2. Architecture — decide stack, data model, integrations
//   3. Frontend design — visual + interaction design
//   4. Completed — final cleanup, docs, ship
//
// Per-task `parallelGroup` is the dependency hint: tasks sharing a
// group number fire together when the stage activates; the next group
// only starts after all tasks in the current group are `done`.
// Eventually an AI pass could replace these hardcoded groups with an
// auto-derived dependency graph from each task's title/description,
// but for now the template author encodes their own dependencies.

export interface TemplateTaskSeed {
  title: string;
  description?: string;
  estimateHours: number;
  tags?: string[];
  // Same parallelGroup value → run in parallel. Next group fires only
  // when prior is fully done. Tasks within the same group are sorted
  // by `position` for display only.
  parallelGroup: number;
}

export interface TemplateStageSeed {
  kind: "scope" | "architecture" | "frontend" | "backend" | "completed" | "custom";
  name: string;
  isIt: string[];
  isNot: string[];
  notes: string;
  tasks: TemplateTaskSeed[];
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  // The IDs of departments this template is the default for.
  defaultForDepartmentIds: string[];
  stages: TemplateStageSeed[];
}

export const SOFTWARE_TEMPLATE: ProjectTemplate = {
  id: "tpl_software_v1",
  label: "Software project",
  description: "Scope → architecture → frontend design → completed. Auto-delegates the next batch when a stage closes.",
  defaultForDepartmentIds: ["dep_software"],
  stages: [
    {
      kind: "scope",
      name: "Initial scope",
      isIt: [
        "A short statement of what we're building and why",
        "The user it serves and the problem it solves",
        "Success criteria — how do we know it shipped well"
      ],
      isNot: [
        "An implementation plan",
        "An exhaustive feature list",
        "A deadline commitment"
      ],
      notes: "Write down the one-paragraph version anyone in the org could understand.",
      tasks: [
        {
          title: "Write the one-paragraph project pitch",
          description: "What we're building, who it's for, why it matters. <120 words.",
          estimateHours: 1,
          tags: ["writing", "scope"],
          parallelGroup: 1
        },
        {
          title: "List the top 3 success criteria",
          description: "Concrete signals we'll watch to know this worked.",
          estimateHours: 1,
          tags: ["scope"],
          parallelGroup: 1
        },
        {
          title: "Identify open questions / blockers for scope sign-off",
          description: "Anything blocking us from architecture? Note them here.",
          estimateHours: 1,
          tags: ["scope"],
          parallelGroup: 2
        }
      ]
    },
    {
      kind: "architecture",
      name: "Architecture",
      isIt: [
        "Stack + data model decisions",
        "API contract sketches (request/response shapes)",
        "Integration points called out — auth, external APIs, queues"
      ],
      isNot: [
        "Final UI wireframes",
        "Per-file pseudocode",
        "Performance benchmarks"
      ],
      notes: "Upload the architecture diagram once it exists. Link to ADRs in the notes.",
      tasks: [
        {
          title: "Pick the stack (storage, runtime, framework)",
          description: "Document the choice + the alternatives considered. Blocks downstream tasks.",
          estimateHours: 2,
          tags: ["architecture"],
          parallelGroup: 1
        },
        {
          title: "Draft the data model",
          description: "Table/collection shapes, relationships, indexes. Diagram preferred.",
          estimateHours: 3,
          tags: ["architecture", "backend"],
          parallelGroup: 2
        },
        {
          title: "Draft the API contract",
          description: "Endpoints, request/response shapes, error cases. Markdown OK.",
          estimateHours: 3,
          tags: ["architecture", "backend"],
          parallelGroup: 2
        },
        {
          title: "Identify external integrations + auth approach",
          description: "Third-party services, OAuth flows, webhook surfaces.",
          estimateHours: 2,
          tags: ["architecture"],
          parallelGroup: 2
        },
        {
          title: "Architecture review + sign-off",
          description: "Walk a teammate through the diagrams + contract. Capture pushback.",
          estimateHours: 1,
          tags: ["architecture", "review"],
          parallelGroup: 3
        }
      ]
    },
    {
      kind: "frontend",
      name: "Frontend design",
      isIt: [
        "Visual design: layouts, key states, copy",
        "Interaction design: clicks, transitions, error handling",
        "Component breakdown for build"
      ],
      isNot: [
        "Backend implementation",
        "Production-ready code",
        "Marketing copy / launch assets"
      ],
      notes: "Drop Figma frames or screenshots into the gallery. Lock visual style before touching code.",
      tasks: [
        {
          title: "Wireframe the primary screens",
          description: "Low-fi sketches of every screen the user touches.",
          estimateHours: 4,
          tags: ["design", "frontend"],
          parallelGroup: 1
        },
        {
          title: "Define empty / loading / error states",
          description: "Every async surface gets all three. Document each.",
          estimateHours: 2,
          tags: ["design", "frontend"],
          parallelGroup: 2
        },
        {
          title: "High-fidelity mockups",
          description: "Pixel-level Figma frames including final copy.",
          estimateHours: 6,
          tags: ["design", "frontend"],
          parallelGroup: 2
        },
        {
          title: "Component breakdown + spec",
          description: "Translate mockups into a component tree with reusable atoms.",
          estimateHours: 3,
          tags: ["frontend", "components"],
          parallelGroup: 3
        }
      ]
    },
    {
      kind: "completed",
      name: "Completed",
      isIt: [
        "Built, reviewed, deployed",
        "Docs + handoff written",
        "Success criteria from the scope stage have been checked"
      ],
      isNot: [
        "A wishlist for v2",
        "Open bugs",
        "The retro"
      ],
      notes: "When this stage closes, the project is shipped.",
      tasks: [
        {
          title: "Code review of the final implementation",
          description: "Walk through the diff with a teammate. Capture follow-ups.",
          estimateHours: 2,
          tags: ["review"],
          parallelGroup: 1
        },
        {
          title: "Write user-facing release notes",
          description: "What changed, who benefits, how to use it.",
          estimateHours: 1,
          tags: ["writing", "release"],
          parallelGroup: 1
        },
        {
          title: "Confirm success criteria met",
          description: "Check each criterion from the scope stage. Note exceptions.",
          estimateHours: 1,
          tags: ["release"],
          parallelGroup: 2
        },
        {
          title: "Deploy + monitor for 24h",
          description: "Watch logs / metrics for the first day after ship.",
          estimateHours: 2,
          tags: ["release", "monitoring"],
          parallelGroup: 2
        }
      ]
    }
  ]
};

export const PROJECT_TEMPLATES: Record<string, ProjectTemplate> = {
  [SOFTWARE_TEMPLATE.id]: SOFTWARE_TEMPLATE
};

export function pickTemplateForDepartment(
  departmentId: string | null,
  departmentName?: string | null
): ProjectTemplate | null {
  // Exact id match first.
  if (departmentId) {
    for (const tpl of Object.values(PROJECT_TEMPLATES)) {
      if (tpl.defaultForDepartmentIds.includes(departmentId)) return tpl;
    }
  }
  // Fuzzy: department name contains "software"/"engineering" → software
  // template. Keeps things working when the actual department id differs
  // from the mock-data fixtures (different workspaces, renamed depts).
  if (departmentName) {
    const lc = departmentName.toLowerCase();
    if (lc.includes("software") || lc.includes("engineering") || lc.includes("eng")) {
      return SOFTWARE_TEMPLATE;
    }
  }
  // Last resort: until we have department-specific templates, default
  // every new project to the software flow. Better than landing on an
  // empty stage list.
  return SOFTWARE_TEMPLATE;
}
