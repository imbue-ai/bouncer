---
name: execute-implementation-plan
description: |
  Execute an implementation plan by working through each task file in order.
  Use when an implementation plan folder exists at docs/<feature>/implementation_plan/.
disable-model-invocation: true
argument-hint: <feature-name>
---

# Execute Implementation Plan

## Input

Feature name: $ARGUMENTS

## Before starting

1. **Read the overview file** at `docs/$ARGUMENTS/implementation_plan/00_overview.md`. This is the ONLY file you read right now — do not read any task files yet.

2. **Build the TODO list** from the Task Index table in the overview. For each row, create a TODO entry with this exact format:

   `Read and execute docs/$ARGUMENTS/implementation_plan/<filename>`

   For example:
   - "Read and execute docs/my-feature/implementation_plan/01_01_install_diffs.md" — pending
   - "Read and execute docs/my-feature/implementation_plan/01_02_replace_changes_tab.md" — pending
   - "Read and execute docs/my-feature/implementation_plan/02_01_add_config_fields.md" — pending

## Executing tasks

Work through the TODO list in order. For each entry:

1. Mark it as in_progress
2. Read the task file specified in the TODO entry
3. Follow the instructions in `.claude/skills/execute-implementation-plan/implement_task.md` to implement, verify, self-review, and commit the task
4. Mark it as completed
5. Move to the next entry

If a task fails with a hard blocker you cannot resolve, stop and ask the user how to proceed.

## Do not

- Read task files ahead of time — only read each task file when you start working on it
- Skip verification steps
- Commit if verification is failing
- Proceed past a failed task without asking the user
