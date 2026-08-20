---
name: frontend-design
description: This skill should be used when the user asks to build or redesign web components, pages, or applications and the result must feel intentionally designed rather than like a generic AI UI. It combines strong frontend art direction with explicit anti-pattern rules for dashboards and product surfaces.
---

# Frontend Design

## Use When
- User requests a new frontend page/component/app with strong visual quality.
- Task needs deliberate visual direction beyond generic UI patterns.
- Task needs a redesign away from default "AI dashboard" aesthetics.

## Don't Use When
- User asks for tiny mechanical UI fixes within strict existing design system rules.
- Task is backend-only with no user-facing surface.

## Inputs and Assumptions
- Product context, user goals, and platform constraints.
- Existing design system constraints (if any).
- Accessibility and performance requirements.

## Execution Workflow
1. Select a clear visual direction and rationale.
2. Decide whether the surface is `brand-forward` or `product-normal` before styling.
3. Define typography, color system, spacing, and motion approach.
4. Implement production-ready UI with responsive behavior.
5. Remove AI-default patterns before calling the design finished.
6. Validate interaction states, mobile behavior, and accessibility basics.

## Expected Outputs
- Working frontend implementation with intentional design system.
- Brief design rationale describing major choices.

## Failure Modes and Recovery
- Conflicting design constraints: prioritize established system patterns and document tradeoffs.
- Unclear aesthetic direction: propose 2-3 distinct directions and pick one explicitly.

## Gotchas and Constraints
- Avoid default-stack visual sameness.
- Distinctive design must still preserve usability and responsiveness.
- Internal tools should feel calm, readable, and product-shaped before they feel expressive.



This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices, but do not confuse "creative" with "decorated." Human-designed UI usually looks more deliberate because it exercises restraint in structure and emphasis.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Stance

Before coding, understand the context and choose the right kind of ambition:
- `Brand-forward surfaces`: marketing sites, launch pages, storytelling pages, portfolios, editorial features. Push typography, composition, imagery, and motion harder here.
- `Product-normal surfaces`: dashboards, settings, admin tools, workspaces, tables, forms, internal apps. Keep information architecture normal and familiar. Distinctiveness should come from typography, color judgment, density, and hierarchy, not from decorative chrome.

Start from product reality, not from a generated aesthetic preset. If the interface is an internal tool, avoid inventing novelty in the layout skeleton. If the interface is a marketing or editorial surface, take bigger visual swings while keeping interaction patterns clear.

## Design Thinking

Before coding, understand the context and commit to a clear design direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work; the key is intentionality, not intensity. For product UI, that intention often means choosing the harder, cleaner, more ordinary structure instead of a flashy default.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Mandatory Anti-Pattern Filter

Run every design through this filter before finishing:
- Do not default to glass panels, floating shells, blur haze, or glow-heavy surfaces.
- Do not start dashboards with a hero block, decorative copy, or eyebrow labels.
- Do not use oversized radii, pill buttons, or rounded badges across every component.
- Do not use fake charts, donut charts, progress bars, or KPI card grids unless the product actually needs them.
- Do not rely on "premium SaaS dark mode" shortcuts like blue-black gradients, cyan accents, or glossy shadows.
- Do not use transform-heavy hover effects as the main source of polish.
- Do not fill empty space with decorative side panels, labels, status dots, or invented operational language.
- Do not let mobile layouts collapse into a single overpadded stack with no prioritization.

If a choice looks like the first thing an AI would generate for a startup dashboard, remove one layer of decoration and restate the hierarchy more plainly.

Load [`references/uncodixify-frontend-rules.md`](references/uncodixify-frontend-rules.md) when the task involves dashboards, admin panels, workspaces, settings, tables, or other product-heavy UI. That file contains the concrete layout and component defaults to enforce.

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic defaults and lazy premium shortcuts. For expressive surfaces, pair a distinctive display face with a refined body face. For product surfaces, choose type that is plain enough to work all day but specific enough to feel chosen.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Keep palettes calm and product-relevant. Distinctive palettes beat default blue-purple startup gradients.
- **Motion**: Use animation with intent, not as surface noise. Prioritize CSS-first solutions where possible. One good reveal or state change is better than hover transforms on everything. In product UI, default to subtle opacity, border, and color transitions.
- **Spatial Composition**: Match the layout to the product type. Editorial and marketing work can break the grid. Internal tools usually should not. Favor clear structure, strong alignment, and purposeful density before introducing asymmetry or overlap.
- **Backgrounds & Visual Details**: Create atmosphere when the surface benefits from it, but avoid decorative fog. Product UI generally wants solid surfaces, disciplined borders, and restrained depth. Brand surfaces can support richer texture, pattern, and layered backgrounds when the concept justifies it.

NEVER use generic AI-generated aesthetics like overused font families, cliched gradient palettes, predictable metric-card compositions, decorative control-room language, or cookie-cutter structures that lack context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, and different visual languages. Do not converge on the same handful of fonts or the same dark SaaS composition across outputs.

## Product-UI Defaults

For product-heavy interfaces, start from these defaults unless the task gives a reason to deviate:
- Simple page structure with normal headers, sections, tables, forms, and navigation.
- Sidebar widths around `240px` to `260px`, solid surfaces, and basic separators if a sidebar is actually needed.
- Card radii around `8px` to `12px`, buttons around `8px` to `10px`, and subtle `1px` borders.
- Spacing on a consistent scale like `4 / 8 / 12 / 16 / 24 / 32`.
- Shadows that stay quiet; prefer border hierarchy over theatrical depth.
- Tabs, badges, dropdowns, and inputs that look functional first and branded second.
- Clear labels above fields and straightforward copy written in the product's voice, not invented startup theater.

## Working Rule

Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animation and detail work. Minimal or refined designs need restraint, precision, and careful attention to spacing, typography, and hierarchy.

Remember: great frontend work is not always louder. Sometimes the right move is to make the structure more ordinary, the typography more exact, and the decoration more scarce. The goal is not to look unlike Codex in a theatrical way; the goal is to produce UI a human designer would actually ship.
