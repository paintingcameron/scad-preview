# SCAD Preview: development plan

A VS Code extension that previews OpenSCAD models with color, customizer sliders, cross-sections
with 2D measurement, and debug-modifier display. The goal is a preview that feels instant while you edit.

CLI capabilities this plan relies on are verified in [openscad-cli-findings.md](openscad-cli-findings.md).

## Goals

1. **Fast**: save or move a slider, and the view updates in place in about 1 s or less for typical models.
2. **Color**: show `color()`, including transparency.
3. **Customizer**: sliders, dropdowns, checkboxes and text fields from the file's parameter comments.
4. **Cross-sections**: cut the model with a movable plane and see the solid cut face.
5. **2D measurement on a slice**: snap to the outline and measure distances, diameters and angles.
6. **Debug modifiers**: show `#` objects highlighted and `%` objects as ghosts.

Not planned: click-to-jump-to-code, and an in-browser (WASM) OpenSCAD.

## Architecture

```
┌───────────── VS Code extension host (Node / TypeScript) ─────────────┐
│ watcher ──► render queue ──► OpenSCAD AppImage (child process)       │
│  (save, deps,   (debounce,      -o model.3mf  -o model.csg           │
│   params)       cancel stale,   -o model.param  -d deps              │
│                 cache by hash)  --summary-file                       │
│        │                                │                            │
│        │       stderr ──► Diagnostics (squiggles)                    │
│        ▼                                ▼                            │
│   postMessage (raw bytes, no base64) ───────────────┐                │
└─────────────────────────────────────────────────────┼────────────────┘
                                                      ▼
┌─────────────── Webview (one persistent panel per file) ──────────────┐
│ Three.js scene · 3MF→BufferGeometry · clipping plane + cap           │
│ customizer panel · 2D slice view + measure tools · modifier overlays │
└──────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **Native AppImage, not WASM**: it's faster, and it's the same build you print from.
- **3MF as the mesh format**: binary-sized, carries colors, and needs no extra export.
- **Mesh work happens in the webview**: slicing, capping and measuring never re-run OpenSCAD,
  so they're instant.
- **Webview persists**: renders swap the mesh; the camera, slice plane and panel state stay.
- **Stack**: TypeScript, esbuild (one bundle each for the extension and the webview), Three.js,
  plain DOM/CSS for the panels (no UI framework until it's needed). Vitest for unit tests.

## Phases

Each phase ends with something usable. Do them in order; phases 3–4 depend on 1, and phase 5
depends on the CSG plumbing being in place.

### Phase 0: Scaffold

- `package.json` with the extension manifest: command `scadPreview.open`, an editor-title button for `.scad`.
- Setting `scadPreview.openscadPath` (default: look for an AppImage next to the workspace, then `openscad` on PATH).
- esbuild config, two entry points: `src/extension.ts` and `webview/main.ts`.
- Webview with a strict CSP; Three.js bundled locally (no CDN).
- **Done when**: F5 opens a dev host, and the command opens an empty panel that shows the OpenSCAD version.

### Phase 1: Render pipeline and viewer

Extension side:
- `Renderer`: spawn OpenSCAD → temp dir → `model.3mf` + `--summary-file`. Pass `--backend=manifold`.
- Trigger on save (on-type rendering stays off by default, behind a setting).
- **Debounce 300 ms; kill the in-flight process** when a newer request arrives.
- Parse stderr into `vscode.Diagnostic`s (`ERROR|WARNING: ... in file X, line N`). Send `ECHO:` to an output channel.
- Status bar: `▲ 716 facets · 0.41 s` or `✖ render failed`.

Webview side:
- 3MF unzip + parse into one `BufferGeometry` with per-triangle colors as vertex colors. Try three's
  `3MFLoader` first; if it handles per-triangle `basematerials` badly, write our own parser (about 150 lines with `fflate`).
- Transparent colors (alpha < 1) are drawn as a second mesh with depth-write off.
- Orbit controls, Z-up to match OpenSCAD, grid, axes, fit-to-view, ortho/perspective toggle, standard views.
- **Keep the camera between renders**; only auto-fit on the first render.
- **Done when**: editing the probe model shows a red box and a translucent blue sphere, with errors underlined in the editor.

**Status: done (2026-10-08).** Added along the way:
- Uncolored parts draw in `scadPreview.defaultColor` (white by default). OpenSCAD runs with
  `--colorscheme=Monotone` so faces cut by uncolored shapes aren't exported green.
- A clickable view cube (Top/Bottom/Front/Back/Left/Right) and an XYZ axis gizmo in the bottom-right, replacing the axis lines.
- An empty model's banner shows the first warning, because an empty result is usually a missing include.
- Dev host launches with the old OpenSCAD preview extension disabled.

### Phase 2: Customizer

- On each render, also export `model.param` (in the same OpenSCAD run, using a second `-o`).
- Build controls from the JSON: number with min/max/step → slider + number box; number without
  range → number box; `options` → dropdown; boolean → checkbox; string → text; vectors → several boxes. Group by `group`.
- Changes send `-D name=value` overrides. Quote strings correctly; booleans as `true`/`false`.
- **Draft quality while dragging**: add `-D $fn=<draftFn>` during the drag (setting, default 16),
  then do one full render on release. Show a "draft" badge.
- Presets: read and write OpenSCAD's own `<file>.json` parameter-set format, so presets also work in the GUI.
- "Reset to defaults" button.
- **Done when**: dragging a slider updates the model without lag, and saved presets open in the OpenSCAD GUI.

**Status: done (2026-10-08).** Changes from the plan:
- Parameters come from our own comment parser (`src/customizer.ts`), not `-o model.param`: each extra
  `-o` re-evaluates the model, which costs ~25 s on BOSL2-heavy files. The parser is tested to match OpenSCAD's export.
- Same-line notes that aren't specs (`gap = 5; // to the edge`) are shown as hints too; OpenSCAD ignores them.
- While dragging, drafts don't cancel each other: the running one finishes and only the newest waiting
  request runs next. Release cancels any draft and renders at full quality.
- "Lag-free" only holds when OpenSCAD itself is fast: a model whose evaluation takes 25 s still takes ~20 s as a draft.

### Phase 3: Cross-section view

- One clipping plane applied to all model materials (`renderer.localClippingEnabled`).
- Plane controls: X/Y/Z axis buttons, flip, offset slider bounded by the model's bounding box,
  and a drag handle in the scene. Arbitrary angle is a later addition.
- **Solid cap** using the stencil-buffer technique (back faces increment, front faces decrement,
  then draw a plane quad where stencil ≠ 0), tinted by the cut object's color, with an optional hatch pattern.
- The plane stays put across re-renders, so you can edit and watch the same slice.
- **Done when**: you can sweep a plane through a model and see solid filled sections with no z-fighting.

**Status: done (2026-10-08).** Changes from the plan:
- The cap is one diagonal hatch, not tinted per part: the stencil method needs a closed mesh, and
  each color is only a patch of the surface. The hatch stands out on any model color.
- Controls are a floating card (top-left); the Parameters panel also floats over the view instead of
  shrinking it. No in-scene drag handle or arbitrary angle yet.
- Verified with headless Chrome screenshots of the real webview bundle (harness kept outside the repo).

### Phase 4: 2D slice and measurement

- **Slice geometry**: intersect every triangle with the plane → segments → join by shared endpoints
  (quantized to 1e-6 mm) → closed loops. Classify outer and hole loops by winding and nesting. Run in a Web Worker for big meshes.
- **2D view**: a split pane or toggle showing the slice in the plane's own coordinates (true scale,
  mm grid, pan/zoom), drawn with Canvas2D or SVG.
- **Snapping**: vertices, edge midpoints, nearest point on edge, and loop centers. A spatial grid index keeps it fast.
- **Tools**:
  - Distance (point to point, with ΔX/ΔY shown)
  - Wall thickness (click an edge, get the perpendicular distance to the opposite edge)
  - Diameter/radius (click a loop, then least-squares circle fit, shown with the facet count)
  - Angle (three points or two edges)
  - Bounding box of the slice or of one loop
- Measurements stay on screen until cleared; copy to clipboard; export the slice as SVG/DXF.
- Note in the UI: measurements are of the faceted mesh. Circle fits report the fitted diameter
  and the across-flats size so the `$fn` error is visible.
- **Done when**: you can slice a printed part at a hole and read its diameter and wall thickness correctly against hand calculation.

**Status: done (2026-10-09).** Changes from the plan:
- No separate 2D view. Measuring happens in the 3D view: with Section on, points land on the cut and
  snap to its outline (corners, hole centres, edges); with Section off, they land on the surface and
  snap to mesh corners. Snapping only happens near a feature; Alt gives a free point.
- Distance only so far, with hole Ø shown while hovering a centre. Wall thickness, angle and
  bounding box moved to phase 4b. No clipboard or SVG/DXF export.
- Added: a list of measurements with per-item show/hide, delete and rename; typed points (absolute
  or relative to the first point); editable coordinates; measurements from the model itself with
  `echo("measure", a, b, "label")`; saved per model in `.scad-preview/<model>.measure.json`.
- Measurements stay on the model when the Measure card is closed.

### Phase 4b: More measuring tools

- **Wall thickness**: click one surface (or a cut edge) and get the distance straight through the
  material to the other side.
- **Angle**: three points (arm, corner, arm).
- **Bounding box**: of one cut outline (with Ø when it's round), or of the whole model.
- Each is saved and listed like a distance.

**Status: done (2026-10-09).** A tool row in the Measure card picks the tool.
Wall and box take one click and preview what they would add while hovering. On the cut, a wall runs
perpendicular to the clicked edge, or along the radius on a round outline (so a faceted hole doesn't
tilt it). On the surface, it follows the inward normal through the mesh. A box on the cut is the
outline under the cursor (a hole, or the part around it), or the whole cut away from them; with
Section off it is the whole model.

### Phase 5: Debug modifiers

- Add `-o model.csg` to the render run.
- Write a small parser for the `.csg` format (only builtin modules, literal args, `multmatrix`, `color`,
  and the `# % ! *` prefixes).
- For each `#` / `%` subtree: rebuild it with all ancestor `multmatrix` and `color` wrappers (but not the
  boolean parents), write `debug_N.csg`, and render to 3MF in parallel.
- Display: `#` as translucent pink drawn over the model, `%` as translucent gray. Both are left out of
  the cross-section cap and slice measurements by default (toggle).
- `!` and `*` already behave correctly in the main export; nothing to do.
- Toggle in the toolbar to hide debug overlays.
- **Done when**: the probe model shows the pink cylinder through the box and the gray cube beside it.

**Status: built (2026-10-09), awaiting a hands-on check.** Changes from the plan:
- Not a second `-o` on the render run (that doubles every render). A separate pass runs after each
  full render, only when the file or a file in its folder uses `#` / `%` (`hasModifiers`, which tells
  the `%` modifier from modulo). It costs one more evaluation (~25 s on the trainer), shows a badge
  while it runs, and is cancelled by the next render. `scadPreview.debugModifiers` turns it off.
- Library files are not scanned: BOSL2 defines helpers such as `ghost()` with `%children()`, which
  would start the pass for every BOSL2 model. Markers applied through such helpers aren't shown.
- The main model is still rendered from the `.scad`, not from the `.csg`: the CSG export rounds numbers
  to 6 significant digits, which changes the mesh (42,888 vs 45,242 facets on the trainer).
- All `#` parts render as one mesh and all `%` parts as another. 2D parts (inside an extrude) are skipped.

### Phase 6: Speed and polish

- **Cache**: key = hash(source + every file in the `-d` deps list + parameters + `$fn` override) → stored 3MF.
  Going back to an earlier slider value is instant.
- **Library watching**: watch every file from the deps list, so editing a `use<>`'d library re-renders.
- Measure AppImage startup overhead. If it dominates small renders, try extracting the AppImage once
  (`--appimage-extract`) and running the binary directly.
- Large-model guardrails: show progress, warn above N facets, and allow cancelling from the status bar.
- Screenshot to PNG, and export the current view's STL/3MF with the current parameters.
- Package as a `.vsix` for local install.

**Status: built (2026-10-09); packaging added 2026-10-12 (`npm run package` → `scad-preview-0.0.1.vsix`).**
- Cache: in memory, shared by panels, 256 MB, least recently used out first. Keyed by program, `-D`
  values and the contents of every file the render read (hashes reused while size and mtime hold),
  stored under the render's own deps so a changed include or library never gives a stale hit. `#` / `%`
  parts are cached with their result. The Render button bypasses it.
- Watching: one watcher per folder of the deps, so changes from outside VS Code (git, other editors,
  library updates) re-render.
- AppImage: measured 0.36 s per run vs 0.06 s unpacked. Unpacked once (~0.8 s, 294 MB) into the
  extension's global storage, reused until the AppImage changes; older copies are deleted.
  `scadPreview.unpackAppImage` turns it off.
- Guardrails: the badge shows elapsed time against the last full render's time, with Cancel (also on
  the status bar item and as a command); over a million facets is flagged in the stats. OpenSCAD's
  CLI reports no progress, so there is no real progress bar.
- Export…: PNG of the view (without panels or measurement overlay), STL (binary) or 3MF. Meshes come
  from the cached full render of the current values when there is one, otherwise OpenSCAD writes the
  file under a cancellable progress notification.

Added after the plan (2026-10-12):
- View cube in the FreeCAD style: faces, edges and corners to click, arrows that step 45° about the
  screen's own axes (over the poles, upside down if need be) and roll 45°, with the X/Y/Z axes as a
  separate gizmo beside it.
- Settings for text size, background, model / measurement / `#` / `%` colours, which side and how wide
  the panels are, the cube's corner and size, the axes, and whether a preview starts orthographic or
  with edges. All apply live.
- `#` / `%` parts draw slightly towards the camera so they don't flicker where they touch the model.
- Section outline fix: a cut just past a row of mesh corners lost some of those corners (the trainer at
  z = 5, 17 and 22 gave squared-off outlines).

## Testing

- **Unit (Vitest)**: stderr → diagnostics parser, param JSON → controls, `-D` quoting, CSG parser,
  slice loop builder (cube, cylinder, cube with hole), circle fit.
- **Fixtures**: `test/fixtures/*.scad` covering color + alpha, every customizer type, `#`/`%`, `include`/`use`, and syntax errors.
- **Manual check per phase**: the "Done when" line above, run against the real `projects/` models.

## Open questions

- Should rendering also happen while typing (unsaved buffer → temp file)? Default is off; revisit after phase 1 timings.
- Show the 2D slice view side by side or as a toggle? Decide after trying both in phase 4.
- Is an arbitrary-angle slice plane worth it, or are axis-aligned planes enough for printing work?
