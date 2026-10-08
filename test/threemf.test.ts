import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLOR, parse3mf, parseHexColor, parseModelXml } from '../webview/threemf';

describe('parse3mf on OpenSCAD output', () => {
  // Generated from colors.scad by OpenSCAD 2026.09.27.
  const data = parse3mf(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'colors.3mf'))));

  function trianglesWithColor(hex: string): number {
    const color = parseHexColor(hex);
    return Array.from(data.materialIndex).filter((i) => {
      const m = data.materials[i];
      return m.r === color.r && m.g === color.g && m.b === color.b && m.a === color.a;
    }).length;
  }

  it('reads every triangle', () => {
    expect(data.materialIndex.length).toBe(728);
    expect(data.positions.length).toBe(728 * 9);
  });

  it('keeps colors, including alpha, and uses the default for uncolored parts', () => {
    expect(trianglesWithColor('#FF0000FF')).toBe(144);
    expect(trianglesWithColor('#007FFF99')).toBe(572);
    expect(trianglesWithColor('#F9D72CFF')).toBe(12);
  });

  it('matches the bounding box OpenSCAD reported', () => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], data.positions[i]);
      max[i % 3] = Math.max(max[i % 3], data.positions[i]);
    }
    expect(min[0]).toBeCloseTo(-4.957224, 4);
    expect(max[0]).toBeCloseTo(34, 4);
    expect(max[1]).toBeCloseTo(34.957224, 4);
    expect(max[2]).toBeCloseTo(10, 4);
  });
});

describe('parseModelXml', () => {
  const tetra = `
    <vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
      <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
    </vertices>
    <triangles>
      <triangle v1="0" v2="2" v3="1"/>
      <triangle v1="0" v2="1" v3="3" p1="1"/>
    </triangles>`;

  it('applies build item transforms', () => {
    const xml = `<model><resources><object id="1"><mesh>${tetra}</mesh></object></resources>
      <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build></model>`;
    const data = parseModelXml(xml);
    expect(Array.from(data.positions.slice(0, 3))).toEqual([10, 20, 30]);
  });

  it('reads color groups and object-level default colors', () => {
    const xml = `<model><resources>
      <m:colorgroup id="5"><m:color color="#00FF00"/><m:color color="#0000FF80"/></m:colorgroup>
      <object id="1" pid="5" pindex="0"><mesh>${tetra}</mesh></object></resources></model>`;
    const data = parseModelXml(xml);
    const [first, second] = Array.from(data.materialIndex).map((i) => data.materials[i]);
    expect(first).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(second.b).toBe(1);
    expect(second.a).toBeCloseTo(0x80 / 255);
  });

  it('places every object when there is no build section', () => {
    const xml = `<model><resources><object id="1"><mesh>${tetra}</mesh></object></resources></model>`;
    const data = parseModelXml(xml);
    expect(data.materialIndex.length).toBe(2);
    expect(data.materials[data.materialIndex[0]]).toEqual(DEFAULT_COLOR);
  });
});

describe('default material', () => {
  it('folds a base named "Default" into material 0', () => {
    const xml = `<model><resources>
      <basematerials id="1"><base name="Default" displaycolor="#F9D72CFF"/><base name="Color 1" displaycolor="#4169E1FF"/></basematerials>
      <object id="2" pid="1" pindex="0"><mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="0"/><triangle v1="0" v2="2" v3="1" pid="1" p1="1"/></triangles>
      </mesh></object></resources></model>`;
    const data = parseModelXml(xml);
    expect(data.materialIndex[0]).toBe(0);
    expect(data.materials[data.materialIndex[1]]).toEqual(parseHexColor('#4169E1'));
  });
});

describe('parseHexColor', () => {
  it('falls back to the default for junk', () => {
    expect(parseHexColor('red')).toEqual(DEFAULT_COLOR);
    expect(parseHexColor(undefined)).toEqual(DEFAULT_COLOR);
  });
});
