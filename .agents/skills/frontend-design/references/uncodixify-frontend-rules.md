# Uncodixify Frontend Rules

Use this reference when building dashboards, admin panels, settings pages, workspace tools, and other product-heavy UI. It exists to block the default AI-dashboard aesthetic and replace it with cleaner, more believable product decisions.

This file is adapted into the local `frontend-design` skill from the upstream `cyxzdev/Uncodixfy` guidance. Treat it as an anti-pattern checklist plus a set of practical defaults.

## Core Principle

For product UI, make the structure normal first. Distinctiveness should come from judgment, not decoration.

That means:
- Use familiar layout primitives.
- Use typography and spacing to create quality.
- Use color with restraint.
- Add visual intensity only when the product or brand actually benefits from it.

If a design choice feels like a shortcut to "premium," it is probably the wrong choice.

## Normal Product Defaults

Use these defaults unless the task clearly calls for something else:
- Sidebars: `240px` to `260px`, fixed or standard responsive collapse, solid background, simple border separation.
- Headers: plain `h1` or `h2`, normal hierarchy, no eyebrow labels, no gradient text, no `<small>` headline blocks.
- Sections: `20px` to `32px` padding, clear grouping, no hero section inside a dashboard.
- Navigation: simple links, subtle hover states, counts only when functional, no decorative "live" badges.
- Buttons: solid fill or simple outline, `8px` to `10px` radius, no pill treatment by default.
- Cards and panels: `8px` to `12px` radius, quiet border, subtle depth if needed.
- Forms: labels above fields, simple help text, straightforward validation and focus styles.
- Inputs: solid border, simple focus ring, no animated underline tricks.
- Modals and dropdowns: centered and direct, simple backdrop, minimal motion.
- Tabs: underline or border indicator, not filled pills.
- Tables: clear rows, subtle separators, left-aligned text, hover only if it improves scanning.
- Badges: small, restrained, and functional. Avoid using badges as decoration.
- Icons: consistent `16px` to `20px`, simple shapes, no decorative icon pills unless the product language calls for it.
- Containers: predictable widths, standard responsive behavior, no novelty framing.
- Toolbars: plain action rows, `48px` to `56px` height, clear alignment.

## Hard No

Do not ship these patterns unless the user explicitly asks for them:
- Floating glassmorphism shells as the default visual language.
- Oversized rounded corners across every surface.
- Pill buttons, pill tabs, pill badges, and pill chips everywhere.
- Dashboard hero sections with marketing copy.
- Decorative operational language that the product never established.
- Generic startup slogans inserted to make the UI feel expensive.
- Fake charts or progress bars added only to fill space.
- Donut charts without a real product reason.
- Glows, blur haze, frosted panels, or colored shadows as decoration.
- "Premium dark mode" built from blue-black gradients plus cyan accents.
- Right-rail filler panels with schedules, notes, or activity blocks that do not matter.
- Brand blocks, workspace promos, or CTA blocks stuffed into sidebars.
- Overpadded layouts that waste vertical space and force scrolling.
- Mobile layouts that just stack every desktop block without reprioritizing.

## Common AI-UI Tells To Remove

Remove these first when a UI starts feeling synthetic:
- Uppercase eyebrow labels with wide letter spacing.
- Repeated metric cards as the first dashboard structure.
- Decorative section intros explaining what the UI supposedly helps with.
- Status dots added with pseudo-elements just to make rows feel alive.
- Gradient progress bars, glossy chart cards, or "live pulse" labels.
- Hover transforms that nudge links, cards, or buttons by a couple of pixels.
- Blue-gray text everywhere until nothing has enough contrast.
- Multiple panel variants nested for no real reason.
- Footer metadata that describes the artifact instead of serving the product.

## Color Guidance

Keep colors calm and role-based:
- Prefer charcoal, ink, stone, sand, olive, rust, oxblood, forest, tobacco, or similar grounded families over default neon SaaS colors.
- In dark themes, start from neutral or slightly warm surfaces rather than electric blue-black.
- In light themes, prefer paper, limestone, bone, fog, sand, or muted industrial tones over pure white plus candy accents.
- Use one real accent color and one support color at most.
- Keep the accent purposeful: states, selection, emphasis, or key actions.

Avoid default combinations like:
- Blue plus cyan plus violet for "futuristic SaaS"
- Purple on white as a generic creativity signal
- Multiple bright accents competing in the same view

## Typography Guidance

Typography should do more of the work than decoration:
- Use readable body sizes around `14px` to `16px` for product UI.
- Build hierarchy with weight, size, spacing, and rhythm before using extra containers.
- For dashboards and tooling, choose a typeface that feels deliberate but not theatrical.
- For marketing or editorial surfaces, push harder on display type, but keep the body type disciplined.
- Avoid leaning on the same internet-default font pairings every time.

## Motion Guidance

For product UI:
- Prefer `100ms` to `200ms` transitions.
- Prioritize color, opacity, and border changes.
- Use transform animation only when it communicates state clearly.
- Keep modal and dropdown motion restrained.

For brand-forward surfaces:
- A stronger page-load sequence or stagger can be appropriate.
- Motion still needs to reinforce the concept, not distract from it.

## Layout Decision Rule

Choose the most believable layout before choosing the most dramatic one.

Ask:
- Would a product designer keep this structure if all decorative styling was removed?
- Does every panel earn its place?
- Would this still read clearly on a busy day with real data?
- Does mobile preserve priorities, or does it just become a long feed of boxes?

If the answer is no, simplify the structure first.

## When To Be Bold

Push harder on expressiveness when the task is:
- A landing page
- A campaign page
- A portfolio
- A branded showcase
- An editorial/storytelling page

Stay stricter and more normal when the task is:
- An admin panel
- A dashboard
- A settings page
- A CRUD-heavy app
- An internal tool
- A data table or workflow surface

Distinctive product UI is still possible, but the distinctiveness should come from tone, typography, density, and clarity, not ornamental wrappers.

## Final Check

Before finishing, verify that:
- The first impression is product clarity, not AI-generated polish.
- The interface has one coherent visual language instead of layered tricks.
- Component shapes, spacing, and hierarchy are consistent.
- Nothing exists only to look premium.
- The result still feels specific to the product and user.
