# Implement Task

You are implementing a single task from an implementation plan. Your job is to read the task file, write the code, verify it works, and commit the changes.

## Steps

1. **Read the task file** at `$TASK_FILE`. This file is self-contained — it has everything you need to know about the task, including background, files to modify, implementation details, and verification steps.

2. **Read the files listed** in the task's "Files to modify/create" and "Background" sections. Understand the existing code before making changes.

3. **Implement the task** following the implementation details in the task file. Key rules:
   - Follow the patterns and conventions described in the task file
   - All imports at the top of the file, no inline imports
   - Do not add unnecessary comments, docstrings, or abstractions beyond what the task requires

4. **Run verification** — these are mandatory, not optional:
   - Run the project's lint/typecheck/format commands. If they fail, fix the issues and re-run. Keep iterating until they pass.
   - Run the project's tests. If tests fail, investigate and fix. Keep iterating until all tests pass.
   - Run any specific tests listed in the task's verification checklist. Keep iterating until all tests pass.
   - For all of the above: keep fixing and re-running until everything passes. Only report failure if you hit a hard blocker that you genuinely cannot resolve.

5. **Walk through the verification checklist** in the task file. Confirm each item passes.

6. **Self-review your diff** before committing:
   - Run `git diff` to see all your staged and unstaged changes
   - Check for: missed requirements from the task spec, bugs, security issues (injection, XSS, hardcoded secrets), dead code, leftover debug statements
   - Fix anything you find and re-run verification

7. **Commit the changes** with a descriptive message explaining what was built and why. Use this format:
   ```
   git commit -m "$(cat <<'EOF'
   Task <task #>: <one-line of what this task accomplished>

   <detailed report of what this task accomplished>
   EOF
   )"
   ```

## Reporting back

When you're done, report one of:
- **Success**: "Task completed and committed. Commit: <hash>. All verification passed."
- **Failure**: "Task failed. <description of what went wrong and what you tried>."

Do not include full test output in your report — just summarize the result.

## Do not

- Modify files outside the scope of this task
- Skip any verification steps
- Commit if verification is failing
- Make architectural decisions that contradict the task file — if something seems wrong, report it as a failure rather than improvising
