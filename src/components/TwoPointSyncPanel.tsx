import { useEffect, useMemo, useState } from 'react';
import type { Cue, GhostBlock, Settings } from '../lib/types';
import { planTwoPointSync } from '../lib/sync';
import { formatTimecode } from '../lib/time';
import TimeCodeInput from './TimeCodeInput';

interface Props {
  cues: Cue[];
  settings: Settings;
  /** 预览虚影变化（null 表示无预览） */
  onGhosts: (ghosts: GhostBlock[] | null) => void;
  /** 确认应用：一次性写入全部校准结果 */
  onApply: (nextCues: Cue[], affectedCount: number) => void;
  /** 点击冲突项时定位片段 */
  onJump: (id: string) => void;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.replace(/<[^>]+>/g, '') ?? '';
}

/**
 * 两点同步面板：选择两个按时间排序的未锁定锚点并分别输入新开始时间，
 * 二者确定唯一线性映射，实时在时间轴上以虚影预览区间内未锁定片段的校准结果；
 * 存在冲突时禁止应用并列出冲突片段，确认后一次性写入全部结果。
 */
export default function TwoPointSyncPanel({ cues, settings, onGhosts, onApply, onJump }: Props) {
  const [anchorAId, setAnchorAId] = useState('');
  const [anchorBId, setAnchorBId] = useState('');
  const [newA, setNewA] = useState<number | null>(null);
  const [newB, setNewB] = useState<number | null>(null);

  const sorted = useMemo(() => [...cues].sort((a, b) => a.start - b.start || a.end - b.end), [cues]);
  const eligible = useMemo(() => sorted.filter((c) => !c.locked), [sorted]);
  const indexOf = (id: string) => sorted.findIndex((c) => c.id === id) + 1;

  const cueA = cues.find((c) => c.id === anchorAId) ?? null;
  const cueB = cues.find((c) => c.id === anchorBId) ?? null;

  // 锚点被锁定或删除时自动清空对应选择
  useEffect(() => {
    if (anchorAId && !eligible.some((c) => c.id === anchorAId)) {
      setAnchorAId('');
      setNewA(null);
    }
    if (anchorBId && !eligible.some((c) => c.id === anchorBId)) {
      setAnchorBId('');
      setNewB(null);
    }
  }, [eligible, anchorAId, anchorBId]);

  const plan = useMemo(() => {
    if (!anchorAId || !anchorBId || newA === null || newB === null) return null;
    return planTwoPointSync({
      cues,
      anchorAId,
      anchorBId,
      newStartA: newA,
      newStartB: newB,
      minDuration: settings.minDuration,
      minGap: settings.minGap,
    });
  }, [cues, anchorAId, anchorBId, newA, newB, settings]);

  // 虚影预览：映射成立即展示（含冲突情形，红色虚线提示）
  const ghosts = useMemo<GhostBlock[] | null>(() => {
    if (!plan || !plan.mappable) return null;
    const bad = plan.conflicts.length > 0;
    const byId = new Map(plan.cues.map((c) => [c.id, c]));
    return plan.affectedIds.map((id) => {
      const c = byId.get(id)!;
      return { id, start: c.start, end: c.end, bad };
    });
  }, [plan]);

  useEffect(() => {
    onGhosts(ghosts);
    return () => onGhosts(null);
  }, [ghosts, onGhosts]);

  function pickAnchor(which: 'A' | 'B', id: string) {
    const cue = cues.find((c) => c.id === id);
    const start = cue ? cue.start : null;
    if (which === 'A') {
      setAnchorAId(id);
      setNewA(start);
    } else {
      setAnchorBId(id);
      setNewB(start);
    }
  }

  function reset() {
    setAnchorAId('');
    setAnchorBId('');
    setNewA(null);
    setNewB(null);
  }

  function apply() {
    if (!plan || !plan.ok) return;
    onApply(plan.cues, plan.affectedIds.length);
    reset();
  }

  const optionLabel = (c: Cue) =>
    `#${indexOf(c.id)} · ${formatTimecode(c.start)} · ${firstLine(c.text).slice(0, 14) || '(空文本)'}`;

  return (
    <section className="panel sync-panel">
      <h2>
        两点同步
        <span className="muted small ml">批量校准</span>
      </h2>
      <p className="muted small">
        选择两个未锁定锚点并分别输入新开始时间，二者确定唯一线性映射；闭区间内所有未锁定片段的
        start/end 一并变换，区间外与锁定片段保持不变。
      </p>

      {eligible.length < 2 ? (
        <p className="muted small">至少需要两个未锁定片段才能进行两点同步。</p>
      ) : (
        <>
          {(['A', 'B'] as const).map((which) => {
            const id = which === 'A' ? anchorAId : anchorBId;
            const cue = which === 'A' ? cueA : cueB;
            const val = which === 'A' ? newA : newB;
            return (
              <div className="sync-anchor" key={which}>
                <div className="sync-anchor-head">
                  <span className="sync-tag">锚点 {which}</span>
                  <select value={id} onChange={(e) => pickAnchor(which, e.target.value)}>
                    <option value="">选择未锁定片段…</option>
                    {eligible.map((c) => (
                      <option key={c.id} value={c.id}>
                        {optionLabel(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sync-anchor-times">
                  <span className="muted small mono">
                    当前 {cue ? formatTimecode(cue.start) : '--:--.---'}
                  </span>
                  <span className="muted small">→ 新开始</span>
                  <TimeCodeInput
                    value={val ?? 0}
                    disabled={!cue}
                    onCommit={(v) => (which === 'A' ? setNewA(v) : setNewB(v))}
                  />
                </div>
              </div>
            );
          })}

          {plan?.mappable && (
            <div className="sync-summary mono">
              <div>
                映射 t′ = {plan.scale.toFixed(4)}·t {plan.offset >= 0 ? '+' : '−'}{' '}
                {Math.abs(plan.offset).toFixed(3)}s
              </div>
              <div>
                区间 {formatTimecode(plan.range[0])} – {formatTimecode(plan.range[1])} · 影响{' '}
                <strong>{plan.affectedIds.length}</strong> 个片段（时间轴虚影预览）
              </div>
            </div>
          )}

          {plan && !plan.mappable && <div className="sync-error">⛔ {plan.error}</div>}

          {plan && plan.conflicts.length > 0 && (
            <div className="sync-conflicts">
              <div>⛔ 存在 {plan.conflicts.length} 处冲突，已禁止应用（不会部分写入）：</div>
              <ul>
                {plan.conflicts.map((c, i) => (
                  <li key={i} onClick={() => c.cueIds[0] && onJump(c.cueIds[0])} title="点击定位片段">
                    <span className="mono">{c.cueIds.map((cid) => `#${indexOf(cid)}`).join(' ↔ ')}</span>{' '}
                    {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="sync-actions">
            <button className="btn" onClick={reset} disabled={!anchorAId && !anchorBId}>
              重置
            </button>
            <button className="btn primary" onClick={apply} disabled={!plan?.ok}>
              应用校准{plan?.mappable ? `（${plan.affectedIds.length} 个片段）` : ''}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
