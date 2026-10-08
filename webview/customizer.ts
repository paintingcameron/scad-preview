import { valuesEqual, type ParamDef, type ParamValue } from '../src/customizer';

export interface CustomizerEvents {
  /** `values` holds only the parameters that differ from their defaults. `draft` is true mid-drag. */
  change(values: Record<string, ParamValue>, draft: boolean): void;
  applyPreset(name: string | undefined): void;
  savePreset(): void;
  deletePreset(): void;
}

interface Row {
  element: HTMLElement;
  /** Show a value in the control without firing change events. */
  show(value: ParamValue): void;
}

/** The customizer side panel: preset bar plus one control per parameter, grouped like the OpenSCAD GUI. */
export class Customizer {
  private defs: ParamDef[] = [];
  private defsKey = '';
  private values: Record<string, ParamValue> = {};
  private readonly rows = new Map<string, Row>();
  private readonly collapsed = new Set<string>();
  private readonly presetSelect: HTMLSelectElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly summary: HTMLElement;
  private readonly foldButton: HTMLButtonElement;
  private readonly body: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly events: CustomizerEvents,
  ) {
    const bar = el('div', 'presets');
    this.presetSelect = el('select');
    this.presetSelect.title = 'Parameter preset';
    this.presetSelect.addEventListener('change', () => events.applyPreset(this.presetSelect.value || undefined));
    const save = button('Save…', 'Save the current values as a preset', () => events.savePreset());
    this.deleteButton = button('Delete', 'Delete the selected preset', () => events.deletePreset());
    const reset = button('Reset', 'Set every parameter back to its default', () => events.applyPreset(undefined));
    bar.append(this.presetSelect, save, this.deleteButton, reset);

    const summaryRow = el('div', 'params-summary');
    this.summary = el('span');
    this.foldButton = button('Collapse all', 'Collapse or expand every group', () => this.toggleAllGroups());
    this.foldButton.className = 'link-button';
    summaryRow.append(this.summary, this.foldButton);
    this.body = el('div', 'params-body');
    root.append(bar, summaryRow, this.body);
    this.setPresets([], undefined);
  }

  get isEmpty(): boolean {
    return this.defs.length === 0;
  }

  setParams(defs: ParamDef[], values: Record<string, ParamValue>): void {
    const key = JSON.stringify(defs);
    if (key !== this.defsKey) {
      this.defs = defs;
      this.defsKey = key;
      this.build();
    }
    this.values = { ...values };
    for (const def of this.defs) {
      const row = this.rows.get(def.name)!;
      row.show(this.current(def));
      row.element.classList.toggle('modified', def.name in this.values);
    }
    this.updateSummary();
  }

  setPresets(names: string[], selected: string | undefined): void {
    this.presetSelect.replaceChildren(new Option('(file defaults)', ''), ...names.map((n) => new Option(n, n)));
    this.presetSelect.value = selected ?? '';
    this.deleteButton.disabled = selected === undefined;
  }

  private current(def: ParamDef): ParamValue {
    return this.values[def.name] ?? def.initial;
  }

  private update(def: ParamDef, value: ParamValue, draft: boolean): void {
    if (valuesEqual(value, def.initial)) delete this.values[def.name];
    else this.values[def.name] = value;
    this.rows.get(def.name)?.element.classList.toggle('modified', def.name in this.values);
    this.updateSummary();
    this.events.change({ ...this.values }, draft);
  }

  private updateSummary(): void {
    const changed = Object.keys(this.values).length;
    this.summary.textContent = `${this.defs.length} parameters${changed ? ` · ${changed} changed` : ''}`;
  }

  private groupElements(): HTMLDetailsElement[] {
    return [...this.body.querySelectorAll<HTMLDetailsElement>('details.group')];
  }

  /** Collapse everything if any group is open, otherwise expand everything. */
  private toggleAllGroups(): void {
    const groups = this.groupElements();
    const open = !groups.some((g) => g.open);
    for (const g of groups) g.open = open; // each fires 'toggle', which updates `collapsed`
    this.updateFoldButton(open);
  }

  private updateFoldButton(anyOpen = this.groupElements().some((g) => g.open)): void {
    this.foldButton.textContent = anyOpen ? 'Collapse all' : 'Expand all';
  }

  private build(): void {
    this.rows.clear();
    const groups = new Map<string, ParamDef[]>();
    for (const def of this.defs) groups.set(def.group, [...(groups.get(def.group) ?? []), def]);

    const sections = [...groups].map(([name, defs]) => {
      const details = el('details', 'group');
      details.open = !this.collapsed.has(name);
      details.addEventListener('toggle', () => {
        if (details.open) this.collapsed.delete(name);
        else this.collapsed.add(name);
        this.updateFoldButton();
      });
      const title = el('summary');
      title.textContent = name;
      details.append(title, ...defs.map((def) => this.buildRow(def)));
      return details;
    });
    this.body.replaceChildren(...sections);
    this.updateFoldButton();
  }

  private buildRow(def: ParamDef): HTMLElement {
    const element = el('div', 'param');
    const head = el('div', 'param-head');
    const label = el('span', 'param-name');
    label.textContent = displayName(def.name);
    // Hover shows the description plus the real variable name, for matching up with the code.
    const hint = def.caption ?? def.note;
    element.title = hint ? `${hint.charAt(0).toUpperCase()}${hint.slice(1)}\n\n${def.name}` : def.name;
    const reset = button('↺', 'Reset to default', () => {
      row.show(def.initial);
      this.update(def, def.initial, false);
    });
    reset.className = 'param-reset';
    head.append(label, reset);
    element.append(head);
    const control = el('div', 'param-control');
    const show = this.buildControl(def, control);
    element.append(control);
    const row: Row = { element, show };
    this.rows.set(def.name, row);
    return element;
  }

  /** Create the input(s) for one parameter; returns a function that displays a value. */
  private buildControl(def: ParamDef, control: HTMLElement): (value: ParamValue) => void {
    if (def.options) {
      const select = el('select');
      def.options.forEach((o, i) => select.append(new Option(o.name, String(i))));
      select.addEventListener('change', () => this.update(def, def.options![Number(select.value)].value, false));
      control.append(select);
      return (value) => {
        const index = def.options!.findIndex((o) => o.value === value);
        select.value = index >= 0 ? String(index) : '';
      };
    }

    if (def.type === 'boolean') {
      const box = input('checkbox');
      box.addEventListener('change', () => this.update(def, box.checked, false));
      control.append(box);
      return (value) => (box.checked = value === true);
    }

    if (def.type === 'string') {
      const text = input('text');
      if (def.maxLength !== undefined) text.maxLength = def.maxLength;
      text.addEventListener('change', () => this.update(def, text.value, false));
      control.append(text);
      return (value) => (text.value = String(value));
    }

    if (Array.isArray(def.initial)) {
      const boxes = def.initial.map(() => this.numberBox(def, () => this.update(def, boxes.map((b) => Number(b.value)), false)));
      control.classList.add('vector');
      control.append(...boxes);
      return (value) => (Array.isArray(value) ? value : []).forEach((v, i) => boxes[i] && (boxes[i].value = String(v)));
    }

    if (def.min !== undefined && def.max !== undefined) {
      const slider = input('range');
      slider.min = String(def.min);
      slider.max = String(def.max);
      slider.step = String(def.step ?? 1);
      const box = this.numberBox(def, () => {
        slider.value = box.value;
        this.update(def, Number(box.value), false);
      });
      // 'input' fires continuously while dragging; 'change' once on release.
      slider.addEventListener('input', () => {
        box.value = slider.value;
        this.update(def, Number(slider.value), true);
      });
      slider.addEventListener('change', () => this.update(def, Number(slider.value), false));
      control.classList.add('slider');
      control.append(slider, box);
      return (value) => {
        slider.value = String(value);
        box.value = String(value);
      };
    }

    const box = this.numberBox(def, () => this.update(def, Number(box.value), false));
    control.append(box);
    return (value) => (box.value = String(value));
  }

  /**
   * A number field that accepts any decimal. Up/Down step by the parameter's step (Shift: ×10)
   * instead of the browser's default, which would snap 1.5 to a whole number.
   */
  private numberBox(def: ParamDef, onCommit: () => void): HTMLInputElement {
    const box = input('number');
    box.step = 'any';
    if (def.min !== undefined) box.min = String(def.min);
    if (def.max !== undefined) box.max = String(def.max);
    let last = '';
    box.addEventListener('focus', () => (last = box.value));
    box.addEventListener('change', () => {
      if (box.value.trim() === '' || !Number.isFinite(Number(box.value))) {
        box.value = last;
        return;
      }
      last = box.value;
      onCommit();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const step = (def.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const next = roundLike(Number(box.value || 0) + step, [box.value, String(step)]);
      box.value = String(next);
      last = box.value;
      onCommit();
    });
    return box;
  }
}

/** `block_top_bottom_rounding` → `Block top bottom rounding`. Special variables like `$fn` stay as written. */
export function displayName(name: string): string {
  if (name.startsWith('$')) return name;
  const words = name.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Round away floating-point noise (0.1 + 0.2) to the most decimals among the inputs. */
function roundLike(n: number, samples: string[]): number {
  const decimals = Math.max(0, ...samples.map((s) => (s.split('.')[1] ?? '').length));
  return Number(n.toFixed(Math.min(decimals, 10)));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function input(type: string): HTMLInputElement {
  const element = el('input');
  element.type = type;
  return element;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
