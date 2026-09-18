import type { Cue } from './types';

export interface SyncConflictItem {
  /** 冲突区间（秒），可用于时间轴标注 */
  range: [number, number];
  reason: string;
  /** 涉及的 cue id（1~2 个） */
  cueIds: string[];
}

export interface SyncPlan {
  /** 输入是否构成合法线性映射（锚点有效、新顺序有效） */
  mappable: boolean;
  /** 映射层面的错误信息（mappable=false 时给出） */
  error?: string;
  /** 线性映射 t′ = scale·t + offset */
  scale: number;
  offset: number;
  /** 校准区间（旧时间，闭区间） */
  range: [number, number];
  /** 区间内未锁定片段 id（将被变换） */
  affectedIds: string[];
  /** 变换后的完整 cue 列表（按 start 排序；仅供预览，仅 ok 时才可写入） */
  cues: Cue[];
  /** 约束冲突列表（时长/间隔），非空则禁止应用 */
  conflicts: SyncConflictItem[];
  /** mappable 且无任何冲突，允许一次性写入 */
  ok: boolean;
}

export interface SyncOptions {
  cues: Cue[];
  anchorAId: string;
  anchorBId: string;
  /** 锚点 A / B 各自的新开始时间（秒） */
  newStartA: number;
  newStartB: number;
  minDuration: number;
  minGap: number;
}

const EPS = 0.0005; // 0.5ms，与问题检测器一致，吸收浮点噪声

function notMappable(error: string): SyncPlan {
  return {
    mappable: false,
    error,
    scale: 1,
    offset: 0,
    range: [0, 0],
    affectedIds: [],
    cues: [],
    conflicts: [],
    ok: false,
  };
}

/**
 * 两点同步批量校准。
 *
 * 以两个锚点的旧/新开始时间确定唯一线性映射 t′ = scale·t + offset，
 * 将闭区间 [较早锚点旧开始, 较晚锚点旧开始] 内所有未锁定片段的 start/end 一并变换；
 * 区间外片段与锁定片段保持不变。
 *
 * 禁止应用的情形（mappable=false 或 conflicts 非空，调用方不得写入任何结果）：
 *  - 锚点缺失/相同/被锁定，或两个锚点旧开始时间过于接近（映射不唯一）；
 *  - 新锚点顺序无效（必须不为负且严格递增）；
 *  - 任一被变换片段的新时长低于当前最小时长；
 *  - 校准后区间内及两侧边界的相邻片段间隔小于当前最小间隔（含重叠）。
 *
 * 函数为纯计算：不修改传入的 cues。
 */
export function planTwoPointSync(opts: SyncOptions): SyncPlan {
  const { cues, minDuration, minGap } = opts;
  const a = cues.find((c) => c.id === opts.anchorAId);
  const b = cues.find((c) => c.id === opts.anchorBId);
  if (!a || !b) return notMappable('请选择两个锚点片段。');
  if (a.id === b.id) return notMappable('两个锚点必须是不同的片段。');
  if (a.locked || b.locked) return notMappable('锚点片段必须未锁定。');
  if (Math.abs(a.start - b.start) < EPS) {
    return notMappable('两个锚点的开始时间过于接近，无法确定唯一线性映射。');
  }

  // 锚点按旧开始时间排序（与用户的选择顺序无关）
  const first = a.start < b.start ? a : b;
  const firstNew = a.start < b.start ? opts.newStartA : opts.newStartB;
  const second = a.start < b.start ? b : a;
  const secondNew = a.start < b.start ? opts.newStartB : opts.newStartA;

  const old1 = first.start;
  const old2 = second.start;
  const new1 = firstNew;
  const new2 = secondNew;

  if (!Number.isFinite(new1) || !Number.isFinite(new2)) {
    return notMappable('请输入两个锚点的新开始时间。');
  }
  if (new1 < -EPS) return notMappable('新锚点顺序无效：新开始时间不能为负。');
  if (new2 <= new1 + EPS) {
    return notMappable('新锚点顺序无效：较晚锚点的新开始时间必须晚于较早锚点。');
  }

  const scale = (new2 - new1) / (old2 - old1);
  const offset = new1 - scale * old1;
  const map = (t: number) => scale * t + offset;

  // 闭区间 [old1, old2] 内的未锁定片段（以片段开始时间判定归属）
  const inRange = (c: Cue) => c.start >= old1 - EPS && c.start <= old2 + EPS;
  const affected = cues.filter((c) => !c.locked && inRange(c));
  const affectedIds = affected.map((c) => c.id);
  const affectedSet = new Set(affectedIds);

  const transformed = cues.map((c) =>
    affectedSet.has(c.id) ? { ...c, start: map(c.start), end: map(c.end) } : c,
  );

  const conflicts: SyncConflictItem[] = [];

  // —— 时长校验：变换后不得短于当前最小时长 ——
  for (const c of affected) {
    const ns = map(c.start);
    const ne = map(c.end);
    if (ne - ns + EPS < minDuration) {
      conflicts.push({
        cueIds: [c.id],
        reason: `变换后时长 ${(ne - ns).toFixed(3)}s，低于最小时长 ${minDuration.toFixed(2)}s`,
        range: [Math.max(0, ns), Math.max(ne, ns)],
      });
    }
  }

  // —— 间隔校验：变换后排序，检查所有涉及受影响片段的相邻对 ——
  // 覆盖区间内相邻对，以及区间两侧边界的相邻对（区间外片段与锁定片段不动，
  // 二者之间不含受影响片段的相邻对不会变化，无需检查）。
  const sorted = [...transformed].sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const p = sorted[i];
    const n = sorted[i + 1];
    if (!affectedSet.has(p.id) && !affectedSet.has(n.id)) continue;
    const gap = n.start - p.end;
    if (gap + EPS < minGap) {
      conflicts.push({
        cueIds: [p.id, n.id],
        reason:
          gap < -EPS
            ? `与相邻片段重叠 ${(-gap).toFixed(3)}s`
            : `与相邻片段间隔仅 ${gap.toFixed(3)}s，小于最小间隔 ${minGap.toFixed(2)}s`,
        range: [Math.min(p.end, n.start), Math.max(p.end, n.start)],
      });
    }
  }

  return {
    mappable: true,
    scale,
    offset,
    range: [old1, old2],
    affectedIds,
    cues: sorted,
    conflicts,
    ok: conflicts.length === 0,
  };
}
