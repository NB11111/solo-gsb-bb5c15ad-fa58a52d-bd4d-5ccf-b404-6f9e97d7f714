import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conflict, Cue, GhostBlock, Settings } from './lib/types';
import { parseVTT, serializeVTT } from './lib/vtt';
import { detectIssues } from './lib/issues';
import { uid } from './lib/time';
import { SAMPLE_VTT } from './lib/sample';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import IssuesPanel from './components/IssuesPanel';
import SettingsPanel from './components/SettingsPanel';
import TwoPointSyncPanel from './components/TwoPointSyncPanel';
import CueList from './components/CueList';
import ImportModal from './components/ImportModal';
import LayoutPreview from './components/LayoutPreview';

export default function App() {
  const initial = useMemo(() => parseVTT(SAMPLE_VTT), []);
  const [cues, setCues] = useState<Cue[]>(initial.cues);
  const [preamble, setPreamble] = useState<string[]>(initial.preamble);
  const [settings, setSettings] = useState<Settings>({ minDuration: 1, minGap: 0.1 });
  const [selectedId, setSelectedId] = useState<string | null>(initial.cues[0]?.id ?? null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [pps, setPps] = useState(60);
  const [toast, setToast] = useState<string | null>(null);
  const [syncGhosts, setSyncGhosts] = useState<GhostBlock[] | null>(null);

  const scrollToRef = useRef<(id: string) => void>(() => {});

  const sortedCues = useMemo(
    () => [...cues].sort((a, b) => a.start - b.start || a.end - b.end),
    [cues],
  );
  const issues = useMemo(() => detectIssues(cues, settings), [cues, settings]);
  // 时间轴上的区间标注只反映时序问题；布局问题归入问题清单与布局预览
  const timingIssues = useMemo(() => issues.filter((i) => i.kind !== 'layout'), [issues]);
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const registerScrollTo = useCallback((fn: (id: string) => void) => {
    scrollToRef.current = fn;
  }, []);

  function patchCue(id: string, patch: Partial<Cue>) {
    setConflict(null);
    setCues((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function deleteCue(id: string) {
    setCues((cs) => cs.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function duplicateCue(id: string) {
    setCues((cs) => {
      const src = cs.find((c) => c.id === id);
      if (!src) return cs;
      const copy: Cue = {
        ...src,
        id: uid(),
        start: src.end + settings.minGap,
        end: src.end + settings.minGap + (src.end - src.start),
        locked: false,
        text: src.text,
      };
      return [...cs, copy];
    });
  }

  function addCue() {
    const lastEnd = cues.reduce((m, c) => Math.max(m, c.end), 0);
    const cue: Cue = {
      id: uid(),
      identifier: '',
      start: lastEnd + settings.minGap,
      end: lastEnd + settings.minGap + Math.max(2, settings.minDuration),
      text: '新字幕',
      settings: '',
      locked: false,
    };
    setCues((cs) => [...cs, cue]);
    setSelectedId(cue.id);
  }

  function load(c: Cue[], p: string[]) {
    setCues(c);
    setPreamble(p);
    setConflict(null);
    setSyncGhosts(null);
    setSelectedId(c[0]?.id ?? null);
  }

  /** 两点同步确认应用：一次性写入全部校准结果 */
  const applySync = useCallback((next: Cue[], count: number) => {
    setCues(next);
    setConflict(null);
    setSyncGhosts(null);
    setToast(`两点同步完成：已校准 ${count} 个片段，区间外与锁定片段保持不变。`);
  }, []);

  function exportVTT() {
    if (cues.length === 0) {
      setToast('没有可导出的片段。');
      return;
    }
    if (errorCount > 0) {
      setToast(`仍有 ${errorCount} 个错误（重叠/非法时间），已按当前内容导出，请先确认。`);
    } else {
      setToast('已导出 WebVTT 文件。');
    }
    const blob = new Blob([serializeVTT(cues, preamble)], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles-fixed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.vtt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selected = cues.find((c) => c.id === selectedId) ?? null;
  const selectedIndex = selected ? sortedCues.findIndex((c) => c.id === selected.id) + 1 : 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🎞️</span>
          <div>
            <h1>WebVTT 字幕时序修复器</h1>
            <span className="muted small">本地运行 · 拖动传播 · 锁定保护 · 两点同步 · 布局预览</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setShowImport(true)}>粘贴 / 导入</button>
          <button className="btn" onClick={addCue}>+ 新建片段</button>
          <button className="btn" onClick={() => load(initial.cues.map((c) => ({ ...c })), initial.preamble)}>
            载入示例
          </button>
          <button className="btn primary" onClick={exportVTT}>导出 WebVTT</button>
        </div>
      </header>

      <main className="layout">
        <div className="center-col">
          <Timeline
            cues={cues}
            settings={settings}
            selectedId={selectedId}
            conflict={conflict}
            issues={timingIssues}
            ghosts={syncGhosts}
            pps={pps}
            onPps={setPps}
            onSelect={setSelectedId}
            onCommit={setCues}
            onConflict={setConflict}
            registerScrollTo={registerScrollTo}
          />

          {conflict && (
            <div className="conflict-banner">
              <span>⛔ 约束无解，已撤销本次调整：{conflict.reason}</span>
              <button
                className="mini"
                onClick={() => {
                  setConflict(null);
                }}
              >
                消除标记
              </button>
            </div>
          )}

          <CueList
            cues={sortedCues}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
            onToggleLock={(id) => patchCue(id, { locked: !cues.find((c) => c.id === id)?.locked })}
          />
        </div>

        <aside className="side-col">
          <SettingsPanel settings={settings} onChange={setSettings} />
          <TwoPointSyncPanel
            cues={cues}
            settings={settings}
            onGhosts={setSyncGhosts}
            onApply={applySync}
            onJump={(id) => {
              setSelectedId(id);
              scrollToRef.current(id);
            }}
          />
          <LayoutPreview cue={selected} />
          <Inspector
            cue={selected}
            index={selectedIndex}
            onPatch={patchCue}
            onDelete={deleteCue}
            onDuplicate={duplicateCue}
          />
          <IssuesPanel
            issues={issues}
            onJump={(issue) => {
              const id = issue.cueIds[0];
              if (id) {
                setSelectedId(id);
                scrollToRef.current(id);
              }
            }}
          />
        </aside>
      </main>

      {showImport && (
        <ImportModal
          hasCues={cues.length > 0}
          onClose={() => setShowImport(false)}
          onLoad={load}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
