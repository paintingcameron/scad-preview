// Source of icon.png: a rounded cube bored through on all three axes, which is the
// difference-of-primitives idea the OpenSCAD logo is built on, held in a silhouette that
// still reads at 16 px.
//
//   openscad -o render.png --imgsize=1024,1024 --projection=o \
//            --camera=0,0,0,54.7356,0,45,150 --colorscheme="Tomorrow Night" media/icon.scad
//
// 54.7356° is the true isometric angle, so the corner view sits the three faces symmetrically;
// 150 is the nearest the orthographic camera gets without clipping the stubs.
//
// A preview render, so the `#` cuts are part of the icon: the extension's own debug-modifier
// display, and the stubs the OpenSCAD logo has. The render is cut out and scaled to 128 px.
// Add -D '$preview=false' for the solid on its own.

$fn = 256;

size = 40;
corner = 6;
bore = 15;
// Past the faces far enough that the debug shape reads as a tunnel, close enough that the
// three stubs still fit the square icon without being cropped.
bore_length = size * 1.22;

icon();
preview_only() #cuts();

module icon() {
  color("#f2c21a") difference() {
    blank();
    cuts();
  }
}

module blank() {
  hull() for (x = [-1, 1], y = [-1, 1], z = [-1, 1])
    translate([x, y, z] * (size / 2 - corner)) sphere(corner);
}

module cuts() {
  for (a = [[0, 0, 0], [90, 0, 0], [0, 90, 0]])
    rotate(a) cylinder(h = bore_length, d = bore, center = true);
}

// Stand-in for the workspace's debug.scad, so this file has no dependencies.
module preview_only() {
  if ($preview) children();
}
