# OpenSCAD CLI findings

Tested against `OpenSCAD-2026.09.27-x86_64.AppImage` on 2026-10-08 with a small probe model
(colored difference, `#` and `%` modifiers, customizer parameters). Everything below was run,
not assumed, unless marked **untested**.

## Render engine

- Manifold is already the default backend (`--backend` help: "'Manifold' (new/fast) [default]").
  No flag needed, but we pass `--backend=manifold` explicitly so a user's GUI setting can't change it.
- Probe model: 716 facets, 0.4 s wall time including AppImage startup; 66 ms of actual geometry
  work (from `--summary time`). **AppImage startup is a real share of small-model render time.**

## Mesh export

- `-o out.3mf` keeps `color()`, including alpha. Colors are written as a `<basematerials>` group
  and each triangle references an entry by index:
  ```xml
  <base name="Default" displaycolor="#F9D72CFF"/>
  <base name="Color 1" displaycolor="#FF0000FF"/>
  <base name="Color 2" displaycolor="#007FFF99"/>
  ```
- The whole model comes out as **one `<object>`** with per-triangle material indices, not one object per color.
- `-O export-3mf/...` options exist: `color-mode` (model/none/selected-only), `material-type`
  (color/basematerial), `decimal-precision`, and others. `--help-export` lists them all.
- `-o -` writes to stdout (verified with `--export-format binstl`: 35 884 bytes). Stdout for 3MF
  (a zip) is **untested**.
- `%` (background) objects are **not** in the exported mesh. The bounding box excludes the `%` cube.
  `#` (highlight) objects take part in the CSG normally and are not shown separately.

## Customizer parameters

`-o out.param` gives the parameter definitions as JSON, already parsed. We don't need our own comment parser:

```json
{"parameters":[
  {"group":"Size","initial":20.0,"max":50.0,"min":5.0,"name":"width","step":1.0,"type":"number"},
  {"caption":"Shape choice","group":"Size","initial":"box","name":"shape",
   "options":[{"name":"box","value":"box"},{"name":"cyl","value":"cyl"}],"type":"string"},
  {"group":"Size","initial":true,"name":"show_lid","type":"boolean"}],
 "title":"probe"}
```

Overrides go in with `-D name=value`, or with `-p file.json -P setName` (the GUI's preset format).

## Debug modifiers via CSG export

`-o out.csg` gives the evaluated tree: variables resolved, loops unrolled, all transforms reduced to
`multmatrix`, and **`#` / `%` markers preserved**:

```
color([1, 0, 0, 1]) {
	difference() {
		cube(size = [20, 20, 10], center = false);
#		multmatrix([[1, 0, 0, 10], [0, 1, 0, 10], [0, 0, 1, -1], [0, 0, 0, 1]]) {
			cylinder($fn = 32, ..., h = 12, r1 = 2.5, r2 = 2.5, center = false);
		}
	}
}
%multmatrix([[1, 0, 0, 30], ...]) { cube(size = [5, 5, 5], center = false); }
```

A `.csg` file is valid OpenSCAD input (`-o x.3mf out.csg` renders the same 716 facets). So
modifiers can be handled by extracting the marked subtrees from the CSG, wrapping each in its
parent transforms, and rendering them as separate meshes. This needs a parser for the simple
`.csg` format, not for full OpenSCAD.

## Diagnostics

Messages go to stderr in this format, which is easy to turn into editor squiggles:

```
ERROR: Parser error: syntax error in file bad.scad, line 3
WARNING: Ignoring unknown variable "undefined_var" in file warn.scad, line 2
```

The exit code is 1 on a parse error. `ECHO:` lines can be captured with `-o out.echo`, or read from stderr.

## Dependencies

`-d deps.file` writes a make-style list of every file the model read (`include`/`use`/`import`).
We use this to re-render when a library file changes, not only the open file.

## Stats

`--summary all --summary-file -` prints JSON with the bounding box, facet/vertex counts, render
time and cache stats. This is useful for the status bar and for auto-framing the camera.
