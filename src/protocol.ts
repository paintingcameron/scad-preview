/** Messages between the extension host and the webview. Shared by both bundles. */
import type { ParamDef, ParamValue } from './customizer';
import type { CodeMeasure, SavedMeasures } from './sharedTypes';

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** The `scadPreview.*` settings the webview uses; see package.json for what each means. */
export interface PreviewSettings {
  defaultColor: string;
  fontSize: number;
  background: string;
  measureColor: string;
  codeMeasureColor: string;
  measureLabelSize: number;
  highlightColor: string;
  backgroundPartColor: string;
  toolsSide: 'left' | 'right';
  toolsWidth: number;
  parametersSide: 'left' | 'right';
  parametersWidth: number;
  viewCube: { show: boolean; corner: Corner; size: number };
  axes: { show: boolean; size: number };
  /** Only used when a preview opens. */
  orthographic: boolean;
  edges: boolean;
}

export type ToWebview =
  | { type: 'status'; openscadPath: string; version?: string; error?: string }
  | { type: 'file'; name: string }
  | { type: 'settings'; settings: PreviewSettings }
  /** Parameter definitions plus the current overrides (values that differ from the defaults). */
  | { type: 'params'; defs: ParamDef[]; values: Record<string, ParamValue> }
  | { type: 'presets'; names: string[]; selected?: string }
  /** Measurements saved for this model, sent once when the panel opens. */
  | { type: 'measures'; saved: SavedMeasures }
  | { type: 'renderStarted'; draft: boolean }
  /** `measures` come from `echo("measure", …)` lines in the model. */
  | {
      type: 'renderDone';
      model: Uint8Array;
      facets?: number;
      /** How long OpenSCAD took; for a cached result, when it was first rendered. */
      ms: number;
      errors: number;
      warnings: number;
      draft: boolean;
      measures: CodeMeasure[];
      cached?: boolean;
    }
  | { type: 'renderCancelled' }
  /** Reply with a `screenshot` message. */
  | { type: 'captureScreenshot' }
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
  | { type: 'saveMeasures'; saved: SavedMeasures }
  | { type: 'cancelRender' }
  | { type: 'export' }
  /** PNG of the 3D view; undefined when it couldn't be captured. */
  | { type: 'screenshot'; png?: Uint8Array };
