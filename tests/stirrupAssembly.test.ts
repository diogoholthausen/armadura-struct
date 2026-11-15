import { describe, it, expect } from 'vitest';
import {
  assemblyBars,
  assemblyBranches,
  fourBranchComposition,
  insertStirrupAssembly,
  recomposeAssembly,
  type StirrupAssembly,
  type StirrupInnerDefinition,
} from '../src/domain/stirrupAssembly';
import { criteriaBar, withStirrupRange } from '../src/domain/stirrups';
import {
  defaultStirrupCriteria,
  type StirrupCriteria,
} from '../src/domain/stirrupSchema';
import { geometry, local, world } from '../src/domain/geometry';
import { stirrupEnvelope } from '../src/domain/stirrupGeometry';
import { emptyProject, schedule, decodeProject } from '../src/domain/model';
import { completeOwnership } from '../src/domain/hierarchy';
import {
  applyRebarBatch,
  executeRebarBatch,
  rebarDefinition,
} from '../src/domain/rebarApi';
import { groupFabrication } from '../src/domain/fabrication';
import { barCadDefaults } from '../src/domain/cadDefaults';
import type { Project } from '../src/domain/types';

const pt = (x: number, y: number) => ({ x, y });

/**
 * Closed axis rectangle w × h with two 135° hooks of 10φ, closing at the first
 * corner: three 90° body bends, each trimming r from both neighbours, and two
 * hook recesses c = r·tan(67,5°).
 *   L = 2w + 2h − 6r − 2c + 3·(π/2)·r + 2·(3π/4)·r + 2·10φ
 */
const developed = (w: number, h: number, phi: number, mandrel: number) => {
  const r = (mandrel + phi) / 2,
    c = r * Math.tan((3 * Math.PI) / 8);
  return 2 * w + 2 * h - 6 * r - 2 * c + 3 * Math.PI * r + 20 * phi;
};
/** Nominal mass (kg): length in mm, φ in mm, ρ = 7850 kg/m³. */
const mass = (lengthMm: number, phi: number) =>
  (lengthMm / 1000) * (Math.PI / 4) * (phi / 1000) ** 2 * 7850;

/** Concrete 250 × 500, cover 25, outer Ø8: axis 192 × 442 (inset 25 + 4). */
const criteria = (): StirrupCriteria => {
  const c = defaultStirrupCriteria();
  Object.assign(c, {
    width: 250,
    height: 500,
    diameter: 8,
    mandrel: 40,
    steel: 'CA-50',
    distribute: true,
    spacing: 200,
    fit: 'fixed',
  });
  Object.assign(c.profile, { reference: 'concrete', cover: 25 });
  return c;
};
const inner = (
  diameter: number,
  pieces: { id: string; x: number }[],
  id = 'internos',
  width = 70,
): StirrupInnerDefinition => ({
  id,
  diameter,
  mandrel: 25,
  steel: 'CA-60',
  width,
  height: 420,
  start: { angle: 135, mode: 'diameters', length: 10, turn: -1 },
  end: { angle: 135, mode: 'diameters', length: 10, turn: 1 },
  pieces: pieces.map((p) => ({ id: p.id, offset: pt(p.x, 11) })),
});
/** 1 outer + 2 equivalent inner pieces per station (generic composition). */
const twoInner = (diameter = 5): StirrupAssembly => ({
  id: 'conjunto',
  outerBarId: 'ext',
  composition: {
    inner: [
      inner(diameter, [
        { id: 'int-a', x: 10 },
        { id: 'int-b', x: 112 },
      ]),
    ],
  },
});
/** Faces 1.800 mm apart, fixed 200 mm pitch: ⌊1800/200⌋ + 1 = 10 stations. */
const range = { start: pt(0, -1000), end: pt(1800, -1000) };
const project = (repetition?: number): Project => {
  const p = completeOwnership(emptyProject());
  return repetition
    ? {
        ...p,
        hierarchy: {
          ...p.hierarchy,
          details: p.hierarchy.details.map((d) => ({
            ...d,
            repetition: { factor: repetition, elements: [] },
          })),
        },
      }
    : p;
};
const insert = (
  p: Project,
  assembly: StirrupAssembly,
  c = criteria(),
  multiplier?: number,
) =>
  insertStirrupAssembly(p, {
    criteria: c,
    assembly,
    origin: pt(0, 0),
    range,
    detailId: p.hierarchy.details[0].id,
    mark: 'N1',
    multiplier,
  });
const rowOf = (p: Project, barId: string) =>
  schedule(p).find((r) => r.contributions.some((c) => c.barId === barId))!;

describe('Conjunto de estribos: externo + internos independentes', () => {
  it('2 ramos: composição vazia reproduz o lançamento atual do estribo simples', () => {
    const c = criteria(),
      p = project();
    const single: StirrupAssembly = {
      id: 'conjunto',
      outerBarId: 'ext',
      composition: { inner: [] },
    };
    const reference = withStirrupRange(
      criteriaBar(c, pt(0, 0), 'N1', 'ext'),
      c,
      range.start,
      range.end,
    );
    expect(assemblyBars(c, single, pt(0, 0), { ext: 'N1' }, range)).toEqual([
      reference,
    ]);
    const b = { ...barCadDefaults(p, reference, true), steel: reference.steel };
    const launched = applyRebarBatch(
      p,
      executeRebarBatch(
        p,
        [
          {
            type: 'bar.create',
            id: b.id,
            detailId: p.hierarchy.details[0].id,
            definition: {
              ...rebarDefinition(b),
              quantitySource: { kind: 'manual' },
            },
          },
          {
            type: 'distribution.set',
            barId: b.id,
            distribution: b.distribution!,
            count: { mode: 'spacing', spacing: 200, fit: 'fixed' },
          },
        ],
        { units: 'mm' },
      ),
    );
    const assembled = insert(p, single, c);
    expect(assembled).toEqual(launched);
    expect(schedule(assembled)).toEqual(schedule(launched));
    expect(assemblyBranches(single)).toBe(2);
  });

  it('comprimento desenvolvido pelo eixo: retos + arcos de dobra + ganchos, com a bitola de cada peça', () => {
    const [outer, a] = assemblyBars(
      criteria(),
      twoInner(5),
      pt(0, 0),
      { ext: 'N1', 'int-a': 'N2', 'int-b': 'N3' },
      range,
    );
    expect(stirrupEnvelope(outer)).toEqual({
      width: 192,
      height: 442,
      inset: 29,
    });
    expect(geometry(outer).errors).toEqual([]);
    expect(geometry(outer).length).toBeCloseTo(developed(192, 442, 8, 40), 9);
    expect(geometry(outer).length).toBeCloseTo(1394.31242, 5);
    expect(geometry(a).length).toBeCloseTo(developed(70, 420, 5, 25), 9);
    expect(geometry(a).length).toBeCloseTo(1058.945263, 5);
    const [, thicker] = assemblyBars(
      criteria(),
      twoInner(6.3),
      pt(0, 0),
      { ext: 'N1', 'int-a': 'N2', 'int-b': 'N3' },
      range,
    );
    expect(geometry(thicker).length).toBeCloseTo(
      developed(70, 420, 6.3, 25),
      9,
    );
    expect(geometry(thicker).length).toBeCloseTo(1084.032891, 5);
  });

  it('10 estações com 1 externo + 2 internos equivalentes geram 10 externos + 20 internos', () => {
    const q = insert(project(), twoInner(5));
    const rows = schedule(q),
      outer = rowOf(q, 'ext'),
      inside = rowOf(q, 'int-a');
    expect(rows).toHaveLength(2);
    expect(outer.quantity).toBe(Math.floor(1800 / 200) + 1);
    expect(inside.contributions.map((c) => c.barId)).toEqual([
      'int-a',
      'int-b',
    ]);
    expect(inside.contributions.map((c) => c.quantity)).toEqual([10, 10]);
    expect(inside.quantity).toBe(10 * 2);
    expect(rows.some((r) => r.quantity === 30)).toBe(false);
  });

  it('externo Ø8 e internos Ø5: comprimento e massa usam a bitola de cada barra', () => {
    const q = insert(project(), twoInner(5));
    const outer = rowOf(q, 'ext'),
      inside = rowOf(q, 'int-a');
    const Le = developed(192, 442, 8, 40),
      Li = developed(70, 420, 5, 25);
    expect(outer.diameter).toBe(8);
    expect(inside.diameter).toBe(5);
    expect(outer.totalLength).toBeCloseTo((10 * Le) / 1000, 9);
    expect(outer.weight).toBeCloseTo(10 * mass(Le, 8), 9);
    expect(outer.weight).toBeCloseTo(5.5017, 3);
    expect(inside.totalLength).toBeCloseTo((20 * Li) / 1000, 9);
    expect(inside.weight).toBeCloseTo(20 * mass(Li, 5), 9);
    expect(inside.weight).toBeCloseTo(3.2644, 3);
  });

  it('trocar só os internos para Ø6,3 mantém o externo idêntico e atualiza os internos', () => {
    const p = project(),
      before = insert(p, twoInner(5));
    const { assembly, removedBarIds } = recomposeAssembly(
      twoInner(5),
      twoInner(6.3).composition,
    );
    expect(removedBarIds).toEqual([]);
    const after = insert(p, assembly);
    const outerBar = (p: Project) => p.bars.find((b) => b.id === 'ext');
    expect(outerBar(after)).toEqual(outerBar(before));
    expect(rowOf(after, 'ext')).toEqual(rowOf(before, 'ext'));
    expect(rowOf(after, 'ext').weight).toBeCloseTo(
      10 * mass(developed(192, 442, 8, 40), 8),
      9,
    );
    const inside = rowOf(after, 'int-a'),
      Li = developed(70, 420, 6.3, 25);
    expect(after.bars.map((b) => b.id)).toEqual(['ext', 'int-a', 'int-b']);
    expect(inside.diameter).toBe(6.3);
    expect(inside.unitLength).toBeCloseTo(Li / 1000, 9);
    expect(inside.weight).toBeCloseTo(20 * mass(Li, 6.3), 9);
    expect(inside.weight).toBeCloseTo(5.3053, 3);
  });

  it('multiplicador 2 × repetição 3 resultam em 60 externos + 120 internos, cada fator uma vez', () => {
    const q = insert(project(3), twoInner(5), criteria(), 2);
    const outer = rowOf(q, 'ext'),
      inside = rowOf(q, 'int-a');
    const Le = developed(192, 442, 8, 40),
      Li = developed(70, 420, 5, 25);
    expect(q.bars.map((b) => [b.quantity, b.multiplier])).toEqual([
      [10, 2],
      [10, 2],
      [10, 2],
    ]);
    expect(outer.quantity).toBe(10 * 2 * 3);
    expect(inside.quantity).toBe(10 * 2 * 2 * 3);
    expect(outer.repetitions).toBe(3);
    expect(outer.totalLength).toBeCloseTo((60 * Le) / 1000, 9);
    expect(outer.totalLength).toBeCloseTo(83.6587, 3);
    expect(outer.weight).toBeCloseTo(60 * mass(Le, 8), 9);
    expect(inside.totalLength).toBeCloseTo((120 * Li) / 1000, 9);
    expect(inside.totalLength).toBeCloseTo(127.0734, 3);
    expect(inside.weight).toBeCloseTo(120 * mass(Li, 5), 9);
  });

  it('consolidação segue a equivalência de fabricação, também entre definições diferentes', () => {
    const separate = (second: StirrupInnerDefinition): StirrupAssembly => ({
      id: 'conjunto',
      outerBarId: 'ext',
      composition: {
        inner: [inner(5, [{ id: 'int-a', x: 10 }], 'esquerda'), second],
      },
    });
    const same = insert(
      project(),
      separate(inner(5, [{ id: 'int-b', x: 112 }], 'direita')),
    );
    expect(schedule(same)).toHaveLength(2);
    expect(rowOf(same, 'int-a').positionId).toBe(
      rowOf(same, 'int-b').positionId,
    );
    expect(rowOf(same, 'int-a').quantity).toBe(20);

    const shorter = insert(
      project(),
      separate(inner(5, [{ id: 'int-b', x: 122 }], 'direita', 60)),
    );
    expect(schedule(shorter)).toHaveLength(3);
    expect(rowOf(shorter, 'int-a').quantity).toBe(10);
    expect(rowOf(shorter, 'int-b').quantity).toBe(10);

    const mixed = insert(
      project(),
      separate(inner(6.3, [{ id: 'int-b', x: 112 }], 'direita')),
    );
    expect(schedule(mixed)).toHaveLength(3);
    expect(rowOf(mixed, 'int-b').diameter).toBe(6.3);
    expect(() => groupFabrication(mixed, ['int-a', 'int-b'], 'int-a')).toThrow(
      /não são equivalentes/,
    );
  });

  it('composição inviável é recusada pelo componente, sem alterar o projeto nem ajustar o externo', () => {
    const p = project(),
      snapshot = JSON.stringify(p);
    const wide: StirrupAssembly = {
      id: 'conjunto',
      outerBarId: 'ext',
      composition: { inner: [inner(5, [{ id: 'int-a', x: 10 }], 'x', 180)] },
    };
    expect(() => insert(p, wide)).toThrow(/Interno 1, peça 1: .*não cabe/);
    expect(() => insert(p, twoInner(12.5))).toThrow(/Interno 1, peça 1/);
    expect(JSON.stringify(p)).toBe(snapshot);
    const circle = criteria();
    circle.profile.shape = 'circle';
    expect(() => insert(p, twoInner(5), circle)).toThrow(/retangular fechado/);
    expect(() => insert(p, twoInner(Number.NaN))).toThrow(/composição/);
    expect(() =>
      insert(p, {
        ...twoInner(5),
        composition: {
          inner: [inner(5, [{ id: 'ext', x: 10 }])],
        },
      }),
    ).toThrow(/ID próprio/);
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('recompor preserva IDs válidos e informa as peças removidas', () => {
    const previous = twoInner(5);
    const one = recomposeAssembly(previous, {
      inner: [inner(5, [{ id: 'int-a', x: 10 }])],
    });
    expect(one.assembly.outerBarId).toBe('ext');
    expect(one.assembly.id).toBe('conjunto');
    expect(one.removedBarIds).toEqual(['int-b']);
    const added = recomposeAssembly(one.assembly, previous.composition);
    expect(added.removedBarIds).toEqual([]);
    const simple = recomposeAssembly(previous, { inner: [] });
    expect(simple.removedBarIds).toEqual(['int-a', 'int-b']);
    expect(assemblyBranches(simple.assembly)).toBe(2);
    expect(() =>
      recomposeAssembly(previous, {
        inner: [
          inner(5, [
            { id: 'int-a', x: 10 },
            { id: 'int-a', x: 112 },
          ]),
        ],
      }),
    ).toThrow(/ID próprio/);
  });

  it('4 ramos: 1 interno centralizado, aninhado sob os ramos horizontais do externo', () => {
    const c = criteria();
    const four = fourBranchComposition(
      c,
      { width: 70, diameter: 5, mandrel: 25 },
      { definition: 'interno', piece: 'int' },
    );
    expect(four.inner[0].height).toBeCloseTo(442 - (8 + 5), 12);
    expect(four.inner[0].pieces[0].offset).toEqual({
      x: (192 - 70) / 2,
      y: (8 + 5) / 2,
    });
    const assembly = { id: 'conjunto', outerBarId: 'ext', composition: four };
    expect(assemblyBranches(assembly)).toBe(4);
    const q = insert(project(), assembly);
    expect(rowOf(q, 'int').quantity).toBe(10);
    expect(rowOf(q, 'int').unitLength).toBeCloseTo(
      developed(70, 442 - 13, 5, 25) / 1000,
      9,
    );
    const thicker = fourBranchComposition(c, {
      width: 70,
      diameter: 6.3,
      mandrel: 25,
    });
    expect(thicker.inner[0].height).toBeCloseTo(442 - (8 + 6.3), 12);
    const free = criteria();
    free.profile.shape = 'free';
    expect(() =>
      fourBranchComposition(free, { width: 70, diameter: 5, mandrel: 25 }),
    ).toThrow(/retangular fechado/);
  });

  it('rotacionar o conjunto transforma todas as peças sem mudar comprimento nem quantidade', () => {
    const marks = { ext: 'N1', 'int-a': 'N2', 'int-b': 'N3' };
    const straight = assemblyBars(
      criteria(),
      twoInner(5),
      pt(500, 300),
      marks,
      range,
    );
    const turned = { ...criteria(), rotation: 90 };
    const rotated = assemblyBars(
      turned,
      twoInner(5),
      pt(500, 300),
      marks,
      range,
    );
    rotated.forEach((b, i) => {
      expect(geometry(b).length).toBeCloseTo(geometry(straight[i]).length, 9);
      expect(b.quantity).toBe(straight[i].quantity);
    });
    const [outer, ...pieces] = rotated,
      { width: W, height: H, inset } = stirrupEnvelope(outer);
    for (const piece of pieces)
      for (const v of geometry(piece).vertices) {
        const q = local(world(v, piece), outer);
        expect(q.x).toBeGreaterThan(inset);
        expect(q.x).toBeLessThan(inset + W);
        expect(q.y).toBeGreaterThan(inset);
        expect(q.y).toBeLessThan(inset + H);
      }
  });

  it('projeto com conjunto mantém o formato atual e reabre sem perda', () => {
    const p = project(),
      q = insert(p, twoInner(5));
    expect(q.schema).toBe(p.schema);
    expect(q.schema).toBe('armadurastruct/35');
    const reopened = decodeProject(JSON.stringify(q));
    expect(reopened).toEqual(q);
    expect(schedule(reopened)).toEqual(schedule(q));
  });
});
