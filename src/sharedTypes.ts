/**
 * Types used by both the extension and the webview. No Node imports here: the webview is type-checked
 * without Node's types.
 */

export type Vec3 = [number, number, number];

/** A measurement the model asks for with `echo("measure", a, b, label)`. */
export interface CodeMeasure {
  a: Vec3;
  b: Vec3;
  label?: string;
}

export type MeasureKind = 'distance' | 'wall' | 'angle' | 'box';

/**
 * A measurement added in the preview (clicked or typed), as saved.
 * - distance, wall: from a to b. `kind` is left out for a distance.
 * - angle: at the corner b, between a and c.
 * - box: a is the low corner, b the high one; `diameter` when the outline it came from is round.
 */
export interface SavedMeasurement {
  kind?: Exclude<MeasureKind, 'distance'>;
  a: Vec3;
  b: Vec3;
  c?: Vec3;
  diameter?: number;
  label?: string;
  hidden?: boolean;
}

/**
 * A model's measurements: `.scad-preview/<model>.measure.json` in the model's folder. Code
 * measurements are rebuilt on every render; only the keys of the ones the user hid are kept.
 */
export interface SavedMeasures {
  measurements: SavedMeasurement[];
  hiddenCode: string[];
}
