/* [Sliders] */
// A full slider
slider = 10; // [0:0.5:20]
// Min and max only
range = 5; // [0:10]
// Max only
max_only = 3; // [10]
/* [Choices] */
num_choice = 2; // [1, 2, 3]
labelled = 10; // [10:Small, 20:Medium, 30:Large]
str_choice = "a"; // [a:Apple, b:Banana]
/* [Other] */
text = "hello"; // 8
flag = false;
vec2 = [1, 2];
vec3 = [1, 2, 3]; // [0:1:10]
spin = 1.5;
/* [Hidden] */
secret = 7;

echo(slider = slider, range = range, max_only = max_only, num_choice = num_choice, labelled = labelled,
     str_choice = str_choice, text = text, flag = flag, vec2 = vec2, vec3 = vec3, spin = spin);
cube(1);
