---
name: extract-requirements-from-mock
description: Extract requirements document from HTML mock iteration
disable-model-invocation: true
argument-hint: [feature-name]
---

# Extract Requirements from Mock

You are extracting a clean requirements document from an HTML mock iteration session.

## Input

Feature name: $ARGUMENTS

## Steps

1. **Locate the feature folder**: Look for `docs/$ARGUMENTS/`
   - If it doesn't exist, ask the user to provide the correct feature name

2. **Gather all context**:
   - Read `mocks.context.md` for the original description, Q&A, and all logged UI tweaks
   - Read `mocks.html` to understand the final UI state
   - Review the conversation history for any additional context

3. **Extract requirements**: Create `docs/$ARGUMENTS/requirements.md` with:
   - **Focus only on user-facing behavior** - what the user sees and can do
   - **No implementation details** - don't specify how things should be built
   - **No acceptance criteria** - just describe the behavior

4. **Structure the requirements doc**:
   ```markdown
   # <Feature Name> - Requirements

   This document specifies the user-facing requirements for <feature>. It describes *what* the system must do from the user's perspective.

   ---

   ## 1. <First Major Area>

   - **REQ-XXX-1:** <requirement>
   - **REQ-XXX-2:** <requirement>

   ## 2. <Second Major Area>
   ...
   ```

5. **Present the requirements** to the user for review.

6. **Optionally regenerate mocks**: Ask the user if they would like to:
   - Rename the old mocks and regenerate fresh ones based on the new requirements
   - Keep the existing mocks as-is
