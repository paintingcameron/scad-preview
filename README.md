# SCAD Preview

A VS Code extension for previewing OpenSCAD models, with color, customizer sliders,
cross-sections and 2D slice measurement. Work in progress; see
[docs/development-plan.md](docs/development-plan.md).

## Develop

```sh
npm install
npm run build      # bundle extension + webview into dist/
npm test           # unit tests
npm run typecheck
```

Press **F5** in VS Code to launch a development host (it opens `../projects`). Open a `.scad`
file and click the preview button in the editor title bar.

## OpenSCAD

Set `scadPreview.openscadPath` to an executable or AppImage. When it is empty, the extension
uses the newest `OpenSCAD*.AppImage` found in the file's folder or any folder above it, then
`openscad` on `PATH`. A recent nightly (2025+) is required for the Manifold backend and colored 3MF export.
