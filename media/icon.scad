
/* [Shape] */
size = 40;
corner = 6;
bore = 15;

/* [Hidden] */
$fn = 256;
// Longer than size, so the cuts pierce the faces and read as tunnels.
bore_length = size * 1.22;

icon();
preview_only() #cuts();

echo("measure", [0, -bore / 2, size / 2 - corner], [0, bore / 2, size / 2 - corner], "bore");
echo("measure", [0, size / 2 - corner, bore / 2], [0, size / 2 - corner, size / 2], "wall");

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

// debug.scad from the workspace library isn't reachable from here.
module preview_only() {
  if ($preview) children();
}
