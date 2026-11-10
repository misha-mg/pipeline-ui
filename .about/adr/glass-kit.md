# The sheet is the CGS Glass kit: its tokens verbatim, its parts under the sheet's class names

Date: 2026-11-06

## Context

The sheet (ADR unification) was the drafting sheet: one light surface, hairline frames, Barlow
Condensed for titles and values, letter-spaced capitals for labels, 3px corners, colour only
where it said something. The team has since settled on one design system for its consoles, the
CGS Glass kit (the cgs-design repository: `tokens.css`, `components.css`, a showcase with this
console's statistics page drawn in it): dark glass by default, translucent surfaces on a dark
window, soft corners, the system face, iOS switches, segmented controls, soft capsules for
states. Two consoles of one line should look like the rest of the team's tools, and a design
decision should be made once, in the kit, not again in each console.

## Decision

`ui/src/sheet.css` opens with the kit's tokens, copied verbatim under the kit's own names
(`--cg-font-*`, `--cg-text-*`, `--cg-space-*`, `--cg-radius-*`, the surfaces, `--cg-fg*`, the
accents and states, the chart series, the shadows, `--cg-ring`, `--cg-dur`, `--cg-ease`), the
dark values on `:root` and the light ones on `:root[data-theme='light']` only: `theme.js` sets the
attribute before the first paint, so the kit's system-setting fallback is not needed here. A
change in the kit's tokens is a copy of a block, nothing to translate. The sheet keeps five of
its own: the chart tokens (`--chart-ok`, `--chart-ok-soft`, `--chart-bad`, `--chart-count`,
`--chart-none`, now aliases of the kit's chart series, since the column chart's SVG contract and
bug-validator's server-side chart name them) and the page's width, gutter and gap.

The parts keep the sheet's class names (`.frame`, `.btn`, `.chip`, `.switch`, `.pill`, `.strip`,
`.cards`, the tables, `.notice`, `.reason`, `dialog.confirm`, `.lamp`, `.bars`, `.columns`,
`.toast`) and take the kit's look: a frame is the kit's card (surface, border, 14px corners, the
gleam), the strip its KPI strip (cells over a 1px grid of the border colour), the cards its stat
tiles, a button its button (a filled surface, 10px corners, no capitals; `.primary` blue,
`.active` the blue tint of the kit's active caps button, `.danger` red under the pointer), a field
its input, the switch its small switch (a white knob, green when on), a `.chips` row and a
filter's `.group` its segmented control (a sunken well whose chip that is on is raised), a pill
its capsule with a soft tint, the masthead its top bar (sticky, blurred over what scrolls under
it) with its brand and mono crumb, a notice and a toast and the confirmation dialog its popover,
the bars its horizontal bars (blue; orange for a stop, as the kit's own statistics screen has
it), the column chart its chart (the muted series, the tooltip as a popover). Labels are the
kit's KPI labels (12px, 600, spaced capitals); headings are the kit's page and chart titles;
the keyboard's focus is one ring (`--cg-ring`) on everything. The markup of the consoles does
not change, but for the statistics' period and grouping filters, which become `.chips` so they
are one segmented control each, as the kit's showcase draws them.

The faces are the kit's stack: the system's SF Pro and SF Mono on a Mac, Inter and JetBrains
Mono served from `/fonts/` otherwise (fontsource's latin woff2 files, OFL, in `ui/public/fonts/`;
the console's CSP allows no font host but its own). Barlow is gone.

`ui/src/style.css` lays out the console's pages with the kit's tokens: the run diagram's blocks
are a raised surface with the kit's corners, the one in flight tinted blue, the terminals
capsules; the queue's new row glows blue.

### The scene (2026-11-09)

The page behind the window was one glow in a corner. It is now the kit's scene: a gradient from
one corner of the screen to the other, a dark at the top left, the kit's blue in between, another
dark at the bottom right, a blue light over it for depth, and over both a grain, so the glass sits
on something and a large dark surface does not band. The grain is one SVG tile of `feTurbulence`
noise in a data URI, laid over at a low opacity (`--grain`; a blend mode loses it on the dark
window); no image file, no script, no library. The gradient drifts a few percent over a minute
and stands still under `prefers-reduced-motion`. Both layers are the body's pseudo-elements,
fixed and under its content; the sheet owns the `--scene-*` tokens and `--grain`, dark and light.

With the scene the accent changes too: the one colour for the thing to press, the active choice,
a link, the keyboard's ring and what is live now is the sheet's own yellow (`--accent`, its fill,
its soft tint, the ink on the fill and `--ring`; the light theme darkens the text colour to read
on white), not the kit's blue, and the scene's hue is the accent's fill. The kit's blue stays the
colour of data: the chart's count series, the bars, the slate pill. The kit's tokens are not
edited for this; the parts name the sheet's tokens, so the next scene is a change of five values.
One kit value is: the light card, white at 72% in the kit, is white at 30% here, glass over the
scene as the dark card is, so the theme switch changes the page and the text, not the blocks.
Every block on the scene is that one surface: the strip is one frame whose hairlines are drawn
into the gaps by the cells' shadows (the kit lays surface cells over a border-coloured frame,
two layers of glass, lighter than the frames beside it), and a segmented control is the same
surface with the frame's border, not the kit's sunken well.

### The mark (2026-11-10)

The masthead carries the company's mark before the brand's name, the app's icon in the window.
It is drawn by the sheet itself, an SVG in a data URI on the brand's `::before`, in the mark's
own four blues, so every console that copies the sheet carries it with no markup and no file of
its own; the console's favicon is the same SVG as `ui/public/logo.svg`.

## Consequences

bug-validator's `npm run sheet:sync` copies the same three paths and needs no change; its copy
falls behind until it syncs, and its own stylesheet must move to the `--cg-*` tokens as this
console's did (the old names, `--slate`, `--moss`, `--rust`, `--line`, `--field`, `--cond`, no
longer exist). A design change starts in the kit: its tokens are copied here as a block, a new
part is drawn here from its component. The kit's `.cg-*` classes are not used in the markup,
so a console reads as before and the kit can evolve without a rename in every view.
