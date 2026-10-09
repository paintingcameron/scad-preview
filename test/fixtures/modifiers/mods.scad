// Modifier probe: # inside a difference (the hole cutter), % beside, nested markers, * and text.
w = 20;
color("red") difference() {
  cube([w, w, 10]);
  translate([10, 10, -1]) #cylinder(r=2.5, h=12, $fn=32);
}
%translate([30, 0, 0]) cube(5);
translate([0, 30, 0]) rotate([0, 0, 45]) {
  #cube(4);
  *sphere(3);
}
for (i = [0:1]) translate([i * 8, -10, 0]) %cylinder(r=2, h=3, $fn=16);
#translate([0, 0, 12]) linear_extrude(1) text("hi \"q\"", size=4);
x = 7 % 3;
echo(x);
