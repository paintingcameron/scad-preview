# Changelog

## 0.1.0

First public release.

- Renders `.scad` files in an editor panel, re-rendering on save and on changes to anything the
  file `include`s or `use`s.
- Colors from `color()`, including transparency.
- Customizer panel built from the file's parameter comments: sliders, dropdowns, checkboxes and
  text fields, with presets. Dragging a slider renders at reduced `$fn` and does one full render
  on release.
- Cross-sections on any axis, with a solid cut face.
- Measurement on a slice: distances, wall thickness, angles and bounding boxes, snapping to the
  outline. `echo("measure", ...)` in the file draws its own measurements.
- `#` (highlight) and `%` (background) parts drawn from a second CSG pass.
- Export to STL or 3MF using the current parameter values.
- Navigation cube, axes, orthographic view and facet edges.
