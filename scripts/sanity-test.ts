import assert from 'node:assert';
import { parseTimecode, formatTimecode } from '../src/lib/time';
import { parseVTT, serializeVTT } from '../src/lib/vtt';
import { applyDrag } from '../src/lib/solver';
import { detectIssues } from '../src/lib/issues';
import {
  parseCueSettings,
  serializeCueSettings,
  getCueSetting,
  updateCueSetting,
  validateLayoutValue,
  analyzeCueLayout,
} from '../src/lib/layout';
import type { Cue, Settings } from '../src/lib/types';

let passed = 0;
function ok(name: string) { passed++; console.log('  ✓', name); }

interface TCue { id: string; s: number; e: number; l?: boolean }
function mk(spec: TCue[]): Cue[] {
  return spec.map((c) => ({
    id: c.id, identifier: '', start: c.s, end: c.e, text: `t-${c.id}`, settings: '', locked: !!c.l,
  }));
}
const get = (cs: Cue[], id: string) => cs.find((c) => c.id === id)!;

// ---------- 时间码 ----------
assert.strictEqual(parseTimecode('00:03.200'), 3.2);
assert.strictEqual(parseTimecode('01:02:03.456'), 3723.456);
assert.strictEqual(parseTimecode('00:03,200'), 3.2);
assert.strictEqual(parseTimecode('99:99.000'), null);
assert.strictEqual(formatTimecode(3.2), '00:03.200');
assert.strictEqual(formatTimecode(3723.456), '01:02:03.456');
ok('时间码解析/格式化');

// ---------- VTT 往返 ----------
const vtt = `WEBVTT

NOTE 请保留我

1
00:00.000 --> 00:02.500 line:90% position:50% align:middle
第一行
<b>第二行</b>

2
00:02.600 --> 00:05.000
你好
`;
const parsed = parseVTT(vtt);
assert.ok(!parsed.error, parsed.error);
assert.strictEqual(parsed.cues.length, 2);
assert.strictEqual(parsed.cues[0].identifier, '1');
assert.strictEqual(parsed.cues[0].settings, 'line:90% position:50% align:middle');
assert.strictEqual(parsed.cues[0].text, '第一行\n<b>第二行</b>');
assert.ok(parsed.preamble.some((p) => p.includes('请保留我')));
const out = serializeVTT(parsed.cues, parsed.preamble);
assert.ok(out.startsWith('WEBVTT\n'));
assert.ok(out.includes('NOTE 请保留我'));
assert.ok(out.includes('line:90% position:50% align:middle'));
assert.ok(out.includes('<b>第二行</b>'));
assert.ok(out.includes('00:00.000 --> 00:02.500'));
const reparsed = parseVTT(out);
assert.strictEqual(reparsed.cues.length, 2);
ok('VTT 解析/序列化保留文本、设置、标识符、NOTE');

// ---------- 求解器 ----------
const GAP = 0.1, MIN = 1;

// 1. 向右移动：推动后续片段，保持时长与间隔
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [1, 3]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  ok('右移推动后续片段');
}

// 2. 向右移动空间充足时不影响更远的片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [5, 6]);
  ok('空间充足时不推动');
}

// 3. 撞锁定片段，中间片段可压缩吸收 => 可行
{
  // a [0,3] b [3.1,6] dur 2.9 ; locked c [6.1,8]
  // a 右缘目标 4.9：b 刚性到 [5.0,7.9] 撞 c(6.1) => 压缩 b 为 [5.0,6.0]（dur 1）恰好可行
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1.9, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b'), c = get(r.cues, 'c'), a = get(r.cues, 'a');
  assert.strictEqual(b.end - b.start >= 1 - 1e-6, true);
  assert.strictEqual(c.start, 6.1); // 锁定不动
  assert.strictEqual(b.end + GAP <= c.start + 1e-6, true);
  assert.strictEqual(a.end + GAP <= b.start + 1e-6, true);
  ok('撞锁定片段时中间片段压缩吸收');
}

// 3b. 同上场景，再多压一点即无解
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.strictEqual(get(r.cues, 'c').start, 6.1);
  ok('压缩到极限后再多拖 => 无解');
}

// 4. 撞锁定片段且无法压缩 => 无解，冲突区间含锁定片段
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 4.2 }, { id: 'c', s: 4.3, e: 8, l: true }]);
  // a 右缘目标 5.5：b 最多压到 [3.2,4.2](dur1)，边界 4.1；5.5>4.1 无解
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict);
  assert.strictEqual(get(r.cues, 'c').start, 4.3);
  ok('锁定阻挡且压缩不足 => 无解');
}

// 5. 向左移动推动前方片段（a 压缩到最小时长）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.1, 3]);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1]);
  ok('左移推动并压缩前方片段');
}

// 5b. 向左移动、间隔仍充足时不影响前方片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 3, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 2.4, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 2]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [2.4, 3.4]);
  ok('左移间隔充足时不推动');
}

// 5c. 向左移动碰到前方片段后刚性平移
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.6, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  // a 刚性平移到 [-0.5,1.5] 后撞墙，压缩吸收为 [0,1.5]（仍满足 gap）；b = [1.6,3.5]
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.6, 3.5]);
  ok('左移刚性平移，越墙部分被吸收');
}

// 6. 向左越界 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: -1.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict!.range[0] === 0);
  ok('向左超出 0s => 无解');
}

// 7. 左侧锁定片段阻挡，中间压缩可吸收 => 可行
{
  // L [0,2] locked; b [2.1,5]; c[5.1,7] 目标 c.start=3
  // b 刚性: end<=2.9 => [0,2.9]? 撞 L: end<=1.9 => 压缩 b start>=2.1(L.end+gap) dur>=1 => end>=3.1
  // c.start=3 <= 3.1+0.1=3.2? 需要 leftBound(3.2) <= 3 => 无解！改成 desired 3.2
  const cs = mk([{ id: 'L', s: 0, e: 2, l: true }, { id: 'b', s: 2.1, e: 5 }, { id: 'c', s: 5.1, e: 7 }]);
  const r = applyDrag({ cues: cs, targetId: 'c', op: 'move', desired: 3.2, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b');
  assert.strictEqual(b.start, 2.1);
  assert.strictEqual(Math.abs(b.end - 3.1) < 1e-6, true);
  assert.strictEqual(get(r.cues, 'L').end, 2);
  ok('左侧锁定 + 中间压缩可行');
}

// 8. resize-end 向右推动后续
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 3.5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 3.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.6, 5.5]);
  ok('右边界拖动推动后续');
}

// 9. resize 短于最小时长 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 0.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  ok('短于最小时长 => 无解');
}

// 10. 锁定目标不可拖（视为无变化可行）
{
  const cs = mk([{ id: 'a', s: 0, e: 2, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.strictEqual(get(r.cues, 'a').start, 0);
  ok('锁定片段自身不移动');
}

// 11. 连续三个片段链式推移，末端开放 => 全部平移，时长保持
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }, { id: 'c', s: 4.1, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  assert.deepStrictEqual([get(r.cues, 'c').start, get(r.cues, 'c').end], [5.1, 7]);
  ok('链式刚性推移');
}

// 12. 原始 baseline 不被修改（撤销语义依赖快照）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const snapshot = JSON.parse(JSON.stringify(cs));
  applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 9, minDuration: MIN, minGap: GAP });
  assert.deepStrictEqual(cs, snapshot);
  ok('输入数组不被原地修改');
}

// ---------- 画面布局：cue 设置编辑 ----------

// 13. 编辑四个布局字段时保留未知设置的原始顺序与内容
{
  const src = 'vertical:rl line:10% foo:bar position:20%';
  // 就地替换，位置不变
  assert.strictEqual(updateCueSetting(src, 'line', '90%'), 'vertical:rl line:90% foo:bar position:20%');
  // 不存在的字段追加到末尾
  assert.strictEqual(updateCueSetting(src, 'size', '80%'), 'vertical:rl line:10% foo:bar position:20% size:80%');
  // 置空即删除，其它设置原样保留
  assert.strictEqual(updateCueSetting(src, 'position', ''), 'vertical:rl line:10% foo:bar');
  // 同名重复设置：替换第一个并移除后续重复项
  assert.strictEqual(updateCueSetting('line:10% line:20% align:left', 'line', '50%'), 'line:50% align:left');
  // 空设置串上新增 / 删除唯一字段
  assert.strictEqual(updateCueSetting('', 'align', 'center'), 'align:center');
  assert.strictEqual(updateCueSetting('align:center', 'align', ''), '');
  // 读取与往返
  assert.strictEqual(getCueSetting(src, 'line'), '10%');
  assert.strictEqual(getCueSetting(src, 'size'), '');
  assert.strictEqual(serializeCueSettings(parseCueSettings(src)), src);
  ok('布局字段编辑保留未知设置的顺序与内容');
}

// 14. 布局字段取值校验
{
  assert.strictEqual(validateLayoutValue('line', '90%'), null);
  assert.strictEqual(validateLayoutValue('line', '12'), null);
  assert.strictEqual(validateLayoutValue('line', '-1,end'), null);
  assert.ok(validateLayoutValue('line', '120%') !== null);
  assert.ok(validateLayoutValue('line', 'abc') !== null);
  assert.strictEqual(validateLayoutValue('position', '50%,line-right'), null);
  assert.ok(validateLayoutValue('position', '50') !== null);
  assert.strictEqual(validateLayoutValue('size', '80%'), null);
  assert.ok(validateLayoutValue('size', '0.5') !== null);
  assert.strictEqual(validateLayoutValue('align', 'center'), null);
  assert.ok(validateLayoutValue('align', 'middle') !== null);
  ok('布局字段取值校验');
}

// 15. 字幕框几何与安全区检测
{
  // 显式 size：按 cue 框计算；line:90%,end 表示框底对齐 90%
  const a = analyzeCueLayout({ settings: 'line:90%,end position:50% size:80% align:center', text: '测试' });
  assert.ok(Math.abs(a.left - 10) < 1e-6 && Math.abs(a.width - 80) < 1e-6);
  assert.ok(Math.abs(a.top - (90 - 5.33)) < 1e-6 && Math.abs(a.height - 5.33) < 1e-6);
  assert.strictEqual(a.errors.length, 0);
  assert.strictEqual(a.outsideSafe, false); // 底边 90%，在容差内

  // line 默认 start 对齐：line:95% => 框顶在 95%，底边越界
  const b = analyzeCueLayout({ settings: 'line:95%', text: '测试文本' });
  assert.strictEqual(b.hasGeometry, true);
  assert.strictEqual(b.outsideSafe, true);
  assert.ok(b.safeViolations.some((v) => v.startsWith('下侧')));

  // position 对齐缺省时按 align 推导：align:right => 框右缘对齐 position
  const c = analyzeCueLayout({ settings: 'position:80% size:40% align:right', text: 'x' });
  assert.ok(Math.abs(c.left - 40) < 1e-6 && Math.abs(c.width - 40) < 1e-6);

  // 无显式几何 => 不做安全区判定；非法 align 进入 errors
  const d = analyzeCueLayout({ settings: 'align:middle', text: 'x' });
  assert.strictEqual(d.hasGeometry, false);
  assert.strictEqual(d.errors.length, 1);
  ok('字幕框几何与安全区检测');
}

// 16. 问题清单包含布局问题（非法值 + 超出安全区），且为警告、可定位到片段
{
  const cs: Cue[] = [
    { id: 'x', identifier: '', start: 0, end: 2, text: '你好', settings: 'align:middle line:95%', locked: false },
    { id: 'y', identifier: '', start: 3, end: 5, text: '世界', settings: '', locked: false },
  ];
  const st: Settings = { minDuration: 1, minGap: 0.1 };
  const iss = detectIssues(cs, st);
  const layout = iss.filter((i) => i.kind === 'layout');
  assert.strictEqual(layout.length, 2);
  assert.ok(layout.every((i) => i.severity === 'warning'));
  assert.ok(layout.every((i) => i.cueIds[0] === 'x'));
  assert.ok(layout.some((i) => i.message.includes('非法')));
  assert.ok(layout.some((i) => i.message.includes('安全区')));
  // 无布局问题的片段不产生 layout 条目
  assert.ok(!layout.some((i) => i.cueIds[0] === 'y'));
  ok('问题清单包含布局非法值与安全区越界');
}

// 17. 布局编辑后导出：未知 cue 设置顺序与内容保留
{
  const v = `WEBVTT

1
00:00.000 --> 00:02.000 vertical:rl line:10% foo:bar
你好
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const c = p.cues[0];
  const updated = updateCueSetting(c.settings, 'position', '40%');
  const out = serializeVTT([{ ...c, settings: updated }], p.preamble);
  assert.ok(out.includes('vertical:rl line:10% foo:bar position:40%'));
  // 时序导出行为不变
  assert.ok(out.includes('00:00.000 --> 00:02.000'));
  ok('导出时未知 cue 设置顺序与内容保留');
}

console.log(`\n全部 ${passed} 组测试通过 ✅`);