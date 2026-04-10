---
name: write-architecture
description: Write an architecture document from goals and requirements
argument-hint: <feature-name>
---

# Write Architecture Document

Read my goals and requirements at `docs/$ARGUMENTS/`

I want you to:
1. Ask clarifying questions or raise concerns about the requirements
2. Deeply analyze the codebase to understand existing patterns and architecture
3. Create an architecture document at `docs/$ARGUMENTS/architecture.md`

## Document structure:

- Executive summary with before/after comparison table
- Current architecture overview (with diagrams)
- Key architectural changes (with diagrams)
- Component deep dives for each major change
- Data model changes (schema, API types)
- Migration strategy (if applicable)
- Code removal plan (if applicable)
- Files to modify/create/delete appendix
- Testing strategy overview

## Guidelines:

- Use ASCII diagrams liberally to illustrate component relationships
- Describe HOW components interact, not implementation code
- Identify alternatives you considered and why you chose this approach
- Call out risks and mitigation strategies
- Prefer YAGNI over extensibility - build for current requirements, not hypothetical future ones
- Reference requirement IDs (`REQ-*`) to show traceability

## Do not:

- Write code in the document
- Include time estimates
