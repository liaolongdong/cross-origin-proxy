/**
 * 日志表格的键盘选行判据 `utils/logRowNavigation.ts`（评审 L-13：详情只有指针一条路）
 *
 * 这一层是「哪个键该动、动到第几行」的全部判据，住在 SFC 里就在全仓没有运行时对应物
 * （node 环境无 DOM，`components/` 渲染不出来），所以判据本身抽成纯函数放这里按
 * 「输入 → 答案」逐个核；界面侧只剩「取 currentTarget、落状态、滚进视野」三件事，
 * 那部分按源码契约钉在 `tests/accessibleNames.test.ts`。
 */
import { describe, it, expect } from 'vitest';
import { resolveLogRowKey } from '@/utils/logRowNavigation';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

describe('不消费的按键：判据的第一条是「别抢走页面的键」', () => {
  it('Tab / Escape / 方向以外的键一律不消费（抢走 Tab 等于弄坏整个抽屉的焦点顺序）', () => {
    for (const key of ['Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'a', 'F5']) {
      expect(resolveLogRowKey(rows(3), 'r0', key)).toEqual({ consumed: false, action: 'none', index: -1 });
    }
  });

  it('空列表时四个键都不消费（没有行可动，也不该把滚动挡掉）', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
      expect(resolveLogRowKey([], null, key)).toEqual({ consumed: false, action: 'none', index: -1 });
    }
  });

  it('一行都没选中时回车/空格不动作（替用户挑第一行展开，等于凭空多出一块内容）', () => {
    for (const key of ['Enter', ' ']) {
      expect(resolveLogRowKey(rows(3), null, key)).toEqual({ consumed: false, action: 'none', index: -1 });
    }
  });
});

describe('移动：↑/↓ 的落点', () => {
  it('未选中时两个方向都落在第一行', () => {
    expect(resolveLogRowKey(rows(3), null, 'ArrowDown')).toEqual({ consumed: true, action: 'move', index: 0 });
    expect(resolveLogRowKey(rows(3), null, 'ArrowUp')).toEqual({ consumed: true, action: 'move', index: 0 });
  });

  it('向下逐行前进、向上逐行后退', () => {
    expect(resolveLogRowKey(rows(3), 'r0', 'ArrowDown').index).toBe(1);
    expect(resolveLogRowKey(rows(3), 'r1', 'ArrowDown').index).toBe(2);
    expect(resolveLogRowKey(rows(3), 'r2', 'ArrowUp').index).toBe(1);
    expect(resolveLogRowKey(rows(3), 'r1', 'ArrowUp').index).toBe(0);
  });

  it('两端停住但仍消费（不消费的话每按一次都把整个抽屉滚一下）', () => {
    expect(resolveLogRowKey(rows(3), 'r2', 'ArrowDown')).toEqual({ consumed: true, action: 'move', index: 2 });
    expect(resolveLogRowKey(rows(3), 'r0', 'ArrowUp')).toEqual({ consumed: true, action: 'move', index: 0 });
  });

  it('单行列表：两个方向都指向那一行', () => {
    expect(resolveLogRowKey(rows(1), 'r0', 'ArrowDown').index).toBe(0);
    expect(resolveLogRowKey(rows(1), 'r0', 'ArrowUp').index).toBe(0);
  });

  it('高亮行已从窗口里消失（自动刷新把旧行挤出去）时回到第一行，而不是停在负下标', () => {
    expect(resolveLogRowKey(rows(3), 'gone', 'ArrowDown').index).toBe(0);
    expect(resolveLogRowKey(rows(3), 'gone', 'ArrowUp').index).toBe(0);
  });
});

describe('展开：Enter / 空格落在当前那一行', () => {
  it('两个键都指向当前高亮行，且不动下标', () => {
    for (const key of ['Enter', ' ']) {
      expect(resolveLogRowKey(rows(3), 'r1', key)).toEqual({ consumed: true, action: 'toggle', index: 1 });
    }
  });

  it('最后一行同样可展开（钳制边界与「越界」在结果上必须分得开）', () => {
    expect(resolveLogRowKey(rows(3), 'r2', 'Enter')).toEqual({ consumed: true, action: 'toggle', index: 2 });
  });
});

describe('判据的自证：结果集不是恒等式', () => {
  it('四格采样给出四个互不相同的下标（把落点写成常量时这一格先红）', () => {
    // rows(4) 的下标是 0..3：未选中起步于 0、r1 向下到 2、r2 向上回 1、末行 r3 向下仍停在 3。
    // 四个答案合起来正好覆盖整列，所以任何「把 index 写死成某个数」的实现都会在这里塌掉。
    const indexes = [
      resolveLogRowKey(rows(4), null, 'ArrowDown').index,
      resolveLogRowKey(rows(4), 'r1', 'ArrowDown').index,
      resolveLogRowKey(rows(4), 'r2', 'ArrowUp').index,
      resolveLogRowKey(rows(4), 'r3', 'ArrowDown').index,
    ];
    expect([...new Set(indexes)].sort()).toEqual([0, 1, 2, 3]);
  });
});
