---
name: create-html-mock
description: Create HTML mocks for a new feature idea
disable-model-invocation: true
argument-hint: [feature description]
---

# Create HTML Mock

You are helping the user explore and refine a feature idea through HTML mocks.

## Initial Setup

1. **Understand the feature**: Read the user's description provided below. Review for inconsistencies, gaps, or potential enhancements. If anything is unclear or ambiguous, ask clarifying questions before proceeding.

2. **Propose a feature name**: Based on the description, propose a short 2-3 word feature name (lowercase, hyphenated). Confirm this name with the user before proceeding.

3. **Create the feature folder automatically**: Use `mkdir -p docs/<feature-name>` to create the directory (this is safe if it already exists). Then create:
   - `docs/<feature-name>/mocks.context.md` - for tracking context (only if it doesn't already exist)

4. **Initialize the context file** (only if newly created) with this structure:
   ```markdown
   # <Feature Name> - Mock Context

   ## Original Description
   <paste the user's original description here>

   ## Clarifying Q&A
   <record any clarifying questions and answers here>

   ## UI Tweaks Log
   <record all UI feedback and tweaks requested during iteration>
   ```

## Creating the Mocks

5. **Generate HTML mocks** that demonstrate the feature:
   - **Make sure it matches the look and feel of the project's existing UI**
   - In a single html file, create multiple mocks showing the various requested scenarios/states
   - Label each one, and also provide a short description of the scenario it is demonstrating
   - Always show the new UI elements within the context of a realistic application window. Don't guess at what the app looks like. Read the UI code and create a close approximation.
   - Include realistic sample data

6. **Never delete previous mocks**: Always create a new file for each iteration (e.g., `mocks.html`, `mocks-v2.html`, `mocks-v3.html`, or use descriptive names). Previous mock files must be preserved.

7. **Always open the HTML file**: After writing a mock file, always run `open <path-to-file>` to open it in the user's browser.

## During Iteration

As the user provides feedback on the mocks:

8. **Log every UI tweak**: Whenever the user requests a change to the mocks, update the "UI Tweaks Log" section in `mocks.context.md` with:
   - What was requested
   - What was changed

   At the end of each response where you make changes, note: *(Logged: [brief description of change])*

9. **Keep the context file current**: This log will be used later to extract requirements, so be thorough.

## User's Feature Description

$ARGUMENTS
