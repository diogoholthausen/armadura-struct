import { z } from 'zod';
import { uid, type Bar, type Point, type Project } from './types';
import { add, world } from './geometry';
import { criteriaBar, withStirrupRange } from './stirrups';
import { stirrupHookSchema, type StirrupCriteria } from './stirrupSchema';
import { stirrupEnvelope } from './stirrupGeometry';
import { fabricationSignature } from './fabrication';
import { barCadDefaults } from './cadDefaults';
import { nextFreeMark } from './marks';
import {
  applyRebarBatch,
  executeRebarBatch,
  rebarDefinition,
  type RebarCommand,
  type RebarOptions,
} from './rebarApi';

const n = z.number().finite();
const identity = z.string().min(1).max(200);

/** Inner closed rectangle measured on its own axis (mm); cover is never deducted again. */
export const stirrupInnerDefinitionSchema = z
  .object({
    id: identity,
    diameter: n.positive().max(100),
    mandrel: n.positive().max(2000),
    steel: z.enum(['CA-50', 'CA-60']),
    width: n.positive().max(100000),
    height: n.positive().max(100000),
    start: stirrupHookSchema,
    end: stirrupHookSchema,
    /** One entry per piece at each station; id is the physical Bar id. */
    pieces: z
      .array(
        z
          .object({
            id: identity,
            /** Lower left inner axis corner, relative to the outer axis corner. */
            offset: z.object({ x: n, y: n }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const stirrupCompositionSchema = z
  .object({ inner: z.array(stirrupInnerDefinitionSchema).max(20) })
  .strict();
export type StirrupInnerDefinition = z.infer<
  typeof stirrupInnerDefinitionSchema
>;
export type StirrupComposition = z.infer<typeof stirrupCompositionSchema>;
/** Organizer only: it has no length or mass; every piece is an ordinary stirrup Bar. */
export type StirrupAssembly = {
  id: string;
  outerBarId: string;
  composition: StirrupComposition;
};

export const assemblyBarIds = (a: StirrupAssembly) => [
  a.outerBarId,
  ...a.composition.inner.flatMap((d) => d.pieces.map((p) => p.id)),
];

/** Physical legs of closed rectangles: two per piece at a station. */
export const assemblyBranches = (a: StirrupAssembly) =>
  2 * assemblyBarIds(a).length;

function validateComposition(a: StirrupAssembly): StirrupComposition {
  const parsed = stirrupCompositionSchema.safeParse(a.composition);
  if (!parsed.success)
    throw Error(
      'Revise a composição: bitolas, mandris e medidas internas devem ser finitos e positivos, com ao menos uma peça por definição.',
    );
  const ids = assemblyBarIds(a),
    definitions = parsed.data.inner.map((d) => d.id);
  if (
    new Set(ids).size !== ids.length ||
    new Set(definitions).size !== definitions.length
  )
    throw Error('Cada componente do conjunto precisa de um ID próprio.');
  return parsed.data;
}

function requireRectangularOuter(criteria: StirrupCriteria, inner: number) {
  if (
    inner &&
    !(criteria.profile.shape === 'rectangle' && criteria.profile.closed)
  )
    throw Error(
      'Componentes internos estão disponíveis apenas para estribo externo retangular fechado.',
    );
}

/** One inner piece centered across the width, nested under the outer horizontal legs. */
export function fourBranchComposition(
  criteria: StirrupCriteria,
  inner: Pick<StirrupInnerDefinition, 'width' | 'diameter' | 'mandrel'> &
    Partial<Pick<StirrupInnerDefinition, 'steel' | 'start' | 'end'>>,
  ids: { definition?: string; piece?: string } = {},
): StirrupComposition {
  requireRectangularOuter(criteria, 1);
  const outer = criteriaBar(criteria, { x: 0, y: 0 }, 'N?', 'outer');
  const { width: W, height: H } = stirrupEnvelope(outer),
    gap = (criteria.diameter + inner.diameter) / 2;
  return {
    inner: [
      {
        id: ids.definition ?? uid(),
        diameter: inner.diameter,
        mandrel: inner.mandrel,
        steel: inner.steel ?? criteria.steel,
        width: inner.width,
        height: H - 2 * gap,
        start: structuredClone(inner.start ?? criteria.profile.start),
        end: structuredClone(inner.end ?? criteria.profile.end),
        pieces: [
          {
            id: ids.piece ?? uid(),
            offset: { x: (W - inner.width) / 2, y: gap },
          },
        ],
      },
    ],
  };
}

/** Outer bar is exactly criteriaBar; each inner piece is an independent physical stirrup. */
export function assemblyBars(
  criteria: StirrupCriteria,
  assembly: StirrupAssembly,
  origin: Point,
  marks: Record<string, string>,
  range?: { start: Point; end: Point; label?: Point },
): Bar[] {
  const composition = validateComposition(assembly);
  requireRectangularOuter(criteria, composition.inner.length);
  if (criteria.distribute && !range)
    throw Error('Indique as faces da faixa para distribuir o conjunto.');
  const mark = (id: string) => {
    if (!marks[id])
      throw Error(`Identificação ausente para o componente ${id}.`);
    return marks[id];
  };
  const distributed = (b: Bar) =>
    criteria.distribute
      ? withStirrupRange(b, criteria, range!.start, range!.end, range!.label)
      : b;
  const outer = criteriaBar(
    criteria,
    origin,
    mark(assembly.outerBarId),
    assembly.outerBarId,
  );
  const { width: W, height: H, inset } = stirrupEnvelope(outer);
  const inner = composition.inner.flatMap((d, i) =>
    d.pieces.map((piece, k) => {
      const label = `Interno ${i + 1}, peça ${k + 1}`,
        gap = (outer.diameter + d.diameter) / 2,
        { x, y } = piece.offset,
        tolerance = 1e-9;
      if (
        x < gap - tolerance ||
        y < gap - tolerance ||
        x + d.width > W - gap + tolerance ||
        y + d.height > H - gap + tolerance
      )
        throw Error(
          `${label}: a face externa do interno (Ø${d.diameter}) não cabe na face interna do externo (Ø${outer.diameter}). Revise medidas, posição ou bitolas.`,
        );
      try {
        return criteriaBar(
          {
            ...criteria,
            width: d.width,
            height: d.height,
            diameter: d.diameter,
            mandrel: d.mandrel,
            steel: d.steel,
            profile: {
              ...criteria.profile,
              shape: 'rectangle',
              closed: true,
              reference: 'axis',
              start: d.start,
              end: d.end,
            },
          },
          world(add({ x: inset, y: inset }, piece.offset), outer),
          mark(piece.id),
          piece.id,
        );
      } catch (e) {
        throw Error(`${label}: ${(e as Error).message}`);
      }
    }),
  );
  return [outer, ...inner].map(distributed);
}

/** Same batch as the single stirrup launch, plus grouping by fabrication equivalence. */
export function assemblyCommands(
  project: Project,
  bars: Bar[],
  detailId: string,
): RebarCommand[] {
  const commands: RebarCommand[] = [];
  for (const source of bars) {
    const b = { ...barCadDefaults(project, source, true), steel: source.steel };
    commands.push({
      type: 'bar.create',
      id: b.id,
      detailId,
      definition: { ...rebarDefinition(b), quantitySource: { kind: 'manual' } },
    });
    if (
      b.distribution &&
      b.quantitySource.kind === 'distribution' &&
      b.quantitySource.mode === 'spacing'
    )
      commands.push({
        type: 'distribution.set',
        barId: b.id,
        distribution: b.distribution,
        count: {
          mode: 'spacing',
          spacing: b.quantitySource.spacing,
          fit: b.quantitySource.fit,
        },
      });
  }
  const groups = new Map<string, string[]>();
  for (const b of bars) {
    const signature = fabricationSignature(b);
    if (signature)
      groups.set(signature, [...(groups.get(signature) ?? []), b.id]);
  }
  for (const ids of groups.values())
    if (ids.length > 1)
      commands.push({
        type: 'fabrication.group',
        ids,
        representativeId: ids[0],
      });
  return commands;
}

/** Pure Project -> Project for a single commit(change); any failure keeps the project intact. */
export function insertStirrupAssembly(
  project: Project,
  input: {
    criteria: StirrupCriteria;
    assembly: StirrupAssembly;
    origin: Point;
    range?: { start: Point; end: Point; label?: Point };
    detailId: string;
    mark: string;
    multiplier?: number;
    options?: Omit<RebarOptions, 'units'>;
  },
): Project {
  const multiplier = input.multiplier ?? 1;
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 10000)
    throw Error('O multiplicador da armadura deve ser inteiro de 1 a 10.000.');
  const used = new Set([...project.bars.map((b) => b.mark), input.mark]);
  const marks: Record<string, string> = {
    [input.assembly.outerBarId]: input.mark,
  };
  for (const id of assemblyBarIds(input.assembly).slice(1)) {
    marks[id] = nextFreeMark(project, used);
    used.add(marks[id]);
  }
  const bars = assemblyBars(
    input.criteria,
    input.assembly,
    input.origin,
    marks,
    input.range,
  ).map((b) => (multiplier === 1 ? b : { ...b, multiplier }));
  return applyRebarBatch(
    project,
    executeRebarBatch(
      project,
      assemblyCommands(project, bars, input.detailId),
      { ...input.options, units: 'mm' },
    ),
  );
}

/** Kept definitions and pieces retain their IDs; removed pieces are reported, never orphaned. */
export function recomposeAssembly(
  previous: StirrupAssembly,
  composition: StirrupComposition,
): { assembly: StirrupAssembly; removedBarIds: string[] } {
  const assembly = { ...previous, composition: structuredClone(composition) };
  validateComposition(assembly);
  const kept = new Set(assemblyBarIds(assembly));
  return {
    assembly,
    removedBarIds: assemblyBarIds(previous).filter((id) => !kept.has(id)),
  };
}
