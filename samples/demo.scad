// Sample model for the development host: exercises color, Customizer controls and the `#` modifier.

/* [Shape] */
// Outer diameter
diameter = 40;
height = 18;
// Number of flutes around the rim
flutes = 12;
flute_depth = 2.2;
bore = 8; // shaft hole

/* [View] */
show_bore = true;

/* [Hidden] */
$fn = 64;

knob();
if (show_bore) preview_only() #bore_cut();

module knob() {
  color("#d0a030")
    difference() {
      cylinder(h = height, d = diameter);
      for (i = [0:flutes - 1])
        rotate([0, 0, i * 360 / flutes])
          translate([diameter / 2, 0, -1])
            cylinder(h = height + 2, d = flute_depth * 2);
      bore_cut();
    }
  color("#4a7fb5") translate([0, 0, height]) cylinder(h = 3, d = diameter * 0.45);
}

module bore_cut() {
  translate([0, 0, -1]) cylinder(h = height + 5, d = bore);
}

// Stand-in for the workspace's debug.scad so the sample has no dependencies.
module preview_only() {
  if ($preview) children();
}
