/** Messages between the extension host and the webview. Shared by both bundles. */
import type { ParamDef, ParamValue } from './customizer';
import type { SavedMeasures } from './measureStore';
import type { CodeMeasure } from './messages';

export type ToWebview =
  | { type: 'status'; openscadPath: string; version?: string; error?: string }
  | { type: 'file'; name: string }
  | { type: 'settings'; defaultColor: string }
  /** Parameter definitions plus the current overrides (values that differ from the defaults). */
  | { type: 'params'; defs: ParamDef[]; values: Record<string, ParamValue> }
  | { type: 'presets'; names: string[]; selected?: string }
  /** Measurements saved for this model, sent once when the panel opens. */
  | { type: 'measures'; saved: SavedMeasures }
  | { type: 'renderStarted'; draft: boolean }
  /** `measures` come from `echo("measure", …)` lines in the model. */
  | { type: 'renderDone'; model: Uint8Array; facets?: number; ms: number; errors: number; warnings: number; draft: boolean; measures: CodeMeasure[] }
  | { type: 'renderEmpty'; ms: number; errors: number; warnings: number; firstProblem?: string }
  | { type: 'renderFailed'; message: string; ms: number }
  /** The second pass for `#` / `%` parts has started; it can take as long as the render. */
  | { type: 'debugStarted' }
  /** 3MF meshes of the `#` and `%` parts; none of either clears them. `failed`: see the output channel. */
  | { type: 'debugParts'; highlight?: Uint8Array; background?: Uint8Array; failed?: boolean };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'rerender' }
  /** `draft` is true while a slider is being dragged. */
  | { type: 'setParams'; values: Record<string, ParamValue>; draft: boolean }
  /** `name` undefined means back to the file's defaults. */
  | { type: 'applyPreset'; name?: string }
  | { type: 'savePreset' }
  | { type: 'deletePreset' }
  | { type: 'saveMeasures'; saved: SavedMeasures };
