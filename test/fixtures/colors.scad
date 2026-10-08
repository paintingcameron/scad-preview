// Fixture for the 3MF reader: two colors (one translucent), an uncolored part, and a hole.
color("red") difference() {
  cube([20, 20, 10]);
  translate([10, 10, -1]) cylinder(h = 12, d = 5, $fn = 32);
}
color([0, 0.5, 1, 0.6]) translate([0, 30, 0]) sphere(5, $fn = 24);
translate([30, 0, 0]) cube(4);
