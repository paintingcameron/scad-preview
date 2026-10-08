// Caption on the line above
a = 1; // [0:10]

// Caption separated by a blank line

b = 2;
c = 1 + 2; // expression: not a parameter
d = "str"; /* a block comment with brackets starts a group [x, y] */
e = -3.5; // negative
f = [1, -2, 3.5];
g = 1e3; // scientific
h = true;
include <nothing_here.scad>
/* [Group A] */
i = 5; // [1:2:9]
j = "x"; // [x, y, z]
k = 4; // [1:One, 4:Four]
l = 3 ; //[ 0 : 5 ]
m = [1, 2]; // [0:0.1:5]
n = undef;
o = PI;
p = [1, "a"];
q = [];
r = 1; r = 2; // reassigned
/* [Hidden] */
s = 9;
/* [Group B] */
t = 10;
module mod() { u = 1; cube(u); }
v = 11; // after a module: not a parameter
function fn() = 1;
w = 12;
cube(1);
x = 13;
if (true) { y = 14; }
