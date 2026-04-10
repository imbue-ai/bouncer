---
name: write-implementation-plan
description: Write an implementation plan from architecture documents
argument-hint: <feature-name>
---

# Write Implementation Plan

You are creating a detailed implementation plan that a developer with zero context about this project can follow to build the feature. Each task is written as a self-contained file so the implementing agent never needs to hold the full plan in context.

## Input

Feature name: $ARGUMENTS

## Steps

1. **Locate the feature folder**: Look for `docs/$ARGUMENTS/`
   - If it doesn't exist, ask the user to provide the correct feature name

2. **Gather all design documents**:
   - Read `goals.md` for the high-level intent
   - Read `requirements.md` for the `REQ-*` identifiers you must trace
   - Read `architecture.md` for component design, data model, and file change plan
   - If `mocks.html` or `mocks.context.md` exist, skim them for UI specifics

3. **Deeply analyze the codebase**: Before writing the plan, understand the existing code you'll be changing. At minimum:
   - Read every file listed in the architecture's "Files to Modify" section
   - Understand the patterns used (state management, routing, API endpoints, component structure, testing)
   - Identify the exact locations where new code will integrate with existing code
   - Use Grep and Glob for targeted searches when you need to find patterns or usages

   **Context management — critical to avoid "prompt too long" failures:**
   - Read files **directly** using the Read tool. Do NOT delegate codebase exploration to sub-agents. Sub-agent transcripts include their full conversation history (every tool call, every file read, all intermediate reasoning), which can be 10-50x larger than the files themselves.
   - If the architecture references many files (>15), prioritize the most important ones first. You can always re-read specific files later when writing individual task files.

4. **Write exploration notes**: After exploring the codebase, write a structured summary of your findings to `implementation_plan/_exploration_notes.md`. This summary should capture:
   - Key file paths and their roles
   - Relevant functions, types, and variables you'll reference in task files
   - Patterns to follow (with specific file:line references)
   - Integration points where new code connects to existing code

   This distills your understanding into a compact reference so earlier file contents can be compressed out of context before the writing phase.

5. **Ask clarifying questions**: If anything in the design documents is ambiguous or if you see conflicts between the architecture and the actual codebase, ask before writing the plan.

6. **Write the plan** as a folder of self-contained task files (see Output Structure below).
   - Write all task files yourself sequentially using the Write tool. Do NOT use sub-agents for writing.
   - Write the `00_overview.md` file first, then write each task file one at a time.
   - This is safe for context because earlier Write tool calls get compressed as you progress, and writing markdown is lightweight compared to the exploration phase.
   - If you find yourself running low on context, re-read `_exploration_notes.md` to refresh your memory rather than re-reading source files.

## Output Structure

Create a folder at `docs/$ARGUMENTS/implementation_plan/` containing:

```
implementation_plan/
  00_overview.md          # Index file listing all tasks in order
  01_01_<task_name>.md    # First task of phase 1
  01_02_<task_name>.md    # Second task of phase 1
  02_01_<task_name>.md    # First task of phase 2
  ...
```

### `00_overview.md` format

```markdown
# <Feature Name> - Implementation Plan

## Summary

<2-3 sentence summary of what's being built and why>

## Phases

- **Phase 1: <Name>** — <what this phase achieves>
- **Phase 2: <Name>** — <what this phase achieves>
- ...

## Phase Rationale

<explain why phases are ordered this way — what depends on what, what unblocks testing early, etc.>

## Task Index

| File | Task | Phase | Requirements |
|------|------|-------|-------------|
| `01_01_<name>.md` | <short description> | 1 | REQ-XXX-1, REQ-XXX-2 |
| `01_02_<name>.md` | <short description> | 1 | REQ-XXX-3 |
| `02_01_<name>.md` | <short description> | 2 | REQ-YYY-1 |
| ... | | | |
```

### Individual task file format

Each task file must be **completely self-contained**. A developer should be able to read just this one file and execute the task successfully without referring to any other plan files.

```markdown
# Task X.Y: <Task Name>

## Goal

<what this task accomplishes>

## Requirements addressed

REQ-XXX-1, REQ-XXX-2

## Background

<Everything the developer needs to know before starting. This section should be thorough enough that someone with zero project context can understand what to do. Include:>

- What this feature/project is about (1-2 sentences)
- What was built in prior tasks that this task depends on (be specific — e.g.: "Task 1.2 added the `FooService` class at `path/to/foo_service.py` and registered it in the dependency container at `path/to/container.py:45`")
- Relevant existing code patterns, naming the specific files, functions, types, and variables involved
- Key architectural decisions from the design docs that affect this task

## Files to modify/create

- `path/to/file.ts` — <what changes and why>
- `path/to/new_file.py` — <new, purpose>

## Implementation details

1. <step-by-step guidance>
2. <reference specific functions, types, patterns from the existing codebase by name>
3. <describe integration points explicitly>

## Testing suggestions

- <how to verify this task works>
- <identify specific tests that exercise the changed code paths — list them by file and test name>

## Gotchas

- <common mistakes to avoid>
- <things that look right but aren't>

## Verification checklist

- [ ] <specific thing to verify for this task>
- [ ] <another specific thing>
- [ ] Tests: <list specific test files/names that exercise the changed code>
```

## Key rules for task files

- **Redundancy is intentional.** Every task file should repeat shared context (project structure, config patterns, API setup, etc.) rather than saying "see overview" or "as described in Task 1.1". The implementing agent will only read one file at a time.
- **Name concrete code.** Don't say "follow the existing pattern" — say "follow the pattern in `SettingsPage.tsx` where `handleSettingChange` calls `updateField(field, value)` on line 213". Name the file, the function, the variable.
- **State what prior tasks produced.** Instead of "depends on Phase 2", name the specific files, types, and functions that the prior task created or modified.
- **Include validation in every file.** Every task file ends with a verification checklist with task-specific checks and relevant tests.
- **Confirm tests with the user.** After writing the plan, present the user with a summary of which tests you've identified for each task. Ask the user to confirm these are the right tests, or suggest additional ones.

## Design principles

- **Thin vertical slices over horizontal layers**: Each phase should produce working, testable functionality end-to-end, not "all backend then all frontend"
- **Remove before building**: If the plan involves replacing existing code, schedule removal early to avoid building on deprecated patterns
- **Earlier phases unblock later phases**: Order phases so that infrastructure and foundational components come first, enabling incremental testing
- **Self-contained tasks**: Each task file must be completable by someone who has only read that file and the source files it references
- **Test as you go**: Every task includes verification steps, not just a "test everything at the end" phase

## Do not

- Write any code or code snippets in the plan (describe what to do, not the code itself)
- Include time estimates
- Create tasks smaller than meaningful progress
- Create tasks larger than 2 hours of focused work
- Use vague references like "follow the existing pattern" without specifying which file/function/line
- Assume the reader has context beyond what's in the task file and the referenced source files
- Reference other task files for context (repeat the context instead)
