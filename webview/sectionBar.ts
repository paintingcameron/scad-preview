import type * as THREE from 'three';
import type { Axis, SectionState } from './section';

/** The row of cross-section controls under the toolbar: axis, flip, and plane position. */
export class SectionBar {
  private state: SectionState;
  /** Whether the offset has been placed for a model yet; the first model centres it. */
  private placed: boolean;
  private bounds?: THREE.Box3;
  private readonly slider: HTMLInputElement;
  private readonly value: HTMLInputElement;
  private readonly axisButtons: HTMLButtonElement[];
  private readonly flipButton: HTMLButtonElement;

  constructor(
    private readonly bar: HTMLElement,
    private readonly toggleButton: HTMLButtonElement,
    initial: SectionState | undefined,
    private readonly onChange: (state: SectionState) => void,
  ) {
    this.state = initial ?? { enabled: false, axis: 'z', offset: 0, flipped: false };
    this.placed = initial !== undefined;
    this.slider = bar.querySelector<HTMLInputElement>('#section-slider')!;
    this.value = bar.querySelector<HTMLInputElement>('#section-value')!;
    this.flipButton = bar.querySelector<HTMLButtonElement>('#section-flip')!;
    this.axisButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-axis]')];

    toggleButton.addEventListener('click', () => this.set({ enabled: !this.state.enabled }));
    for (const b of this.axisButtons) {
      b.addEventListener('click', () => {
        const axis = b.dataset.axis as Axis;
        // A new axis starts at the middle of the model along it.
        this.set({ axis, offset: this.middle(axis) ?? this.state.offset });
      });
    }
    this.flipButton.addEventListener('click', () => this.set({ flipped: !this.state.flipped }));
    this.slider.addEventListener('input', () => this.set({ offset: Number(this.slider.value) }));
    this.value.addEventListener('change', () => {
      const n = Number(this.value.value);
      if (this.value.value.trim() !== '' && Number.isFinite(n)) this.set({ offset: n });
      else this.render();
    });
    this.render();
  }

  get current(): SectionState {
    return { ...this.state };
  }

  /** Called after each new model. The plane stays where it was, except on the very first model. */
  setBounds(bounds: THREE.Box3 | undefined): void {
    this.bounds = bounds;
    if (!this.placed && bounds) {
      this.state.offset = this.middle(this.state.axis) ?? 0;
      this.placed = true;
      this.onChange(this.current);
    }
    this.render();
  }

  private set(change: Partial<SectionState>): void {
    this.state = { ...this.state, ...change };
    this.render();
    this.onChange(this.current);
  }

  private middle(axis: Axis): number | undefined {
    if (!this.bounds || this.bounds.isEmpty()) return undefined;
    return round((this.bounds.min[axis] + this.bounds.max[axis]) / 2);
  }

  private render(): void {
    const { enabled, axis, offset, flipped } = this.state;
    this.bar.hidden = !enabled;
    this.toggleButton.classList.toggle('on', enabled);
    for (const b of this.axisButtons) b.classList.toggle('on', b.dataset.axis === axis);
    this.flipButton.classList.toggle('on', flipped);
    this.flipButton.title = flipped
      ? `Showing ${axis.toUpperCase()} above the plane; click to show below`
      : `Showing ${axis.toUpperCase()} below the plane; click to show above`;

    if (this.bounds && !this.bounds.isEmpty()) {
      // A little past the model on both sides, so the plane can clear it entirely.
      const min = this.bounds.min[axis];
      const max = this.bounds.max[axis];
      const pad = Math.max((max - min) * 0.02, 0.5);
      const span = max - min + 2 * pad;
      this.slider.min = String(round(min - pad));
      this.slider.max = String(round(max + pad));
      this.slider.step = span > 200 ? '0.5' : span > 20 ? '0.1' : '0.01';
    }
    this.slider.value = String(offset);
    if (document.activeElement !== this.value) this.value.value = String(round(offset));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
