/**
 * 自动关闭档位的读写（配置页的下拉与弹窗的档位条共用这一份）
 *
 * 这里只放「档位清单 + 读 + 写 + 把倒计时落点读回来」，不放文案与 `ElMessage`：
 * 措辞由调用方决定（与 `composables/useProfiles.ts` 同一口径）。
 *
 * 谁重建倒计时：唯一的人是后台 `entrypoints/background/autoOff.ts` —— 它监听 `storage.onChanged`，
 * 见到 `AUTO_OFF_MINUTES` 变了就按新时长重挂 alarm。界面因此**只写 storage、只读 alarm**，
 * 绝不自已调 `chrome.alarms.create`：两个写者抢同一个 alarm 名，clear/create 交错就是随机结局。
 */

import {
  STORAGE_KEYS,
  AUTO_OFF_ALARM,
  AUTO_OFF_SYNC_INTERVAL_MS,
  AUTO_OFF_SYNC_TRIES,
  AUTO_OFF_SYNC_TOLERANCE_MS,
} from '@/utils/constants';
import { logger } from '@/utils/logger';

/**
 * 可选档位（分钟，`0` = 从不）。
 *
 * `labelKey` 是配置页那句完整说法（「30 分钟后」），`shortKey` 是弹窗那一格的短标签（「30分」）——
 * 同一档位两种画法，因为弹窗内容宽只有 320px，五格并排放不下「小时后」。
 * 两份 key 都是扁平字典里的键（`utils/i18n` 把 common/options/popup 三个命名空间合并），
 * 所以哪个页面用哪一份都不受命名空间限制。
 */
export const AUTO_OFF_PRESETS: readonly { minutes: number; labelKey: string; shortKey: string }[] = [
  { minutes: 0, labelKey: 'autoOffNever', shortKey: 'autoOffPickNever' },
  { minutes: 30, labelKey: 'autoOff30m', shortKey: 'autoOffPick30m' },
  { minutes: 60, labelKey: 'autoOff1h', shortKey: 'autoOffPick1h' },
  { minutes: 120, labelKey: 'autoOff2h', shortKey: 'autoOffPick2h' },
  { minutes: 240, labelKey: 'autoOff4h', shortKey: 'autoOffPick4h' },
];

/** 档位条与下拉的取值清单，从 `AUTO_OFF_PRESETS` 派生，避免两份清单各长一段 */
export const AUTO_OFF_PRESET_MINUTES: readonly number[] = AUTO_OFF_PRESETS.map(preset => preset.minutes);

/**
 * 读当前档位。
 *
 * 判据与后台 `getAutoOffMinutes` 同一口径：非有限正数一律当「从不」。
 * 手改过的 storage 里躺着 `-5` 时，后台本来就不清倒计时也不建，界面画成「从不」才是与之一致的说法
 * （从前配置页把 `-5` 原样交给下拉，那里没有这一项，于是画出一个空白）。
 */
export async function readAutoOffMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTO_OFF_MINUTES);
  const minutes = result[STORAGE_KEYS.AUTO_OFF_MINUTES];
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * 写入的结果三档，**「写没写进去」与「倒计时读回来没有」是两件事**，不能合成一档：
 * - `applied`：storage 落盘成功，且看见了后台按新时长重建后的落点（`0` 档则是 alarm 已不在）
 * - `unconfirmed`：落盘成功，但在那点预算内没读到预期的落点——设置本身是生效的，只是这一屏的
 *   倒计时读数还可能是旧的，调用方应当重拉一次状态、按读到的画
 * - `failed`：storage 写入抛错，什么都没变（原因已由本模块记日志）
 */
export type AutoOffApplyResult =
  { status: 'applied'; autoOffAt: number | undefined } | { status: 'unconfirmed' } | { status: 'failed' };

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 只写档位，不管倒计时。
 *
 * 配置页的那个下拉要的就是这一层：它同屏没有倒计时读数，没必要跟着轮询一趟。
 * 落点要不要读回来由 {@link applyAutoOffMinutes} 决定。
 */
export async function writeAutoOffMinutes(minutes: number): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.AUTO_OFF_MINUTES]: minutes });
    return true;
  } catch (error) {
    logger.error('Failed to save auto-off minutes:', error);
    return false;
  }
}

/**
 * 写入档位，并尽力把新的倒计时落点读回来。
 *
 * 为什么需要「读回来」：`chrome.storage.local.set` 落回时后台的监听器才刚要起跑，
 * 此刻弹窗里那份 `autoOffAt`（来自 `GET_PROXY_STATUS`，本质是 `chrome.alarms.get`）还是旧的。
 * 直接显示就是拿旧时刻配新档位——「1 小时」的格子亮着，旁边写「0:45 后自动关闭」。
 *
 * 因此这里按固定间隔轮询同一个来源，直到观测值与「刚刚那一刻 + 时长」对得上（容差之内）；
 * 选了「从不」则等那枚 alarm 消失。预算用尽仍对不上时不猜：回 `unconfirmed`，
 * 让调用方重拉一次状态、把后台真正读到的那个值画出来（哪怕它不等于预期——那也是事实）。
 */
export async function applyAutoOffMinutes(minutes: number): Promise<AutoOffApplyResult> {
  if (!(await writeAutoOffMinutes(minutes))) return { status: 'failed' };

  const expectedAt = Date.now() + minutes * 60_000;
  try {
    for (let attempt = 0; attempt < AUTO_OFF_SYNC_TRIES; attempt++) {
      const alarm = await chrome.alarms.get(AUTO_OFF_ALARM);
      if (minutes <= 0) {
        if (!alarm) return { status: 'applied', autoOffAt: undefined };
      } else if (alarm && Math.abs(alarm.scheduledTime - expectedAt) <= AUTO_OFF_SYNC_TOLERANCE_MS) {
        return { status: 'applied', autoOffAt: alarm.scheduledTime };
      }
      if (attempt < AUTO_OFF_SYNC_TRIES - 1) await delay(AUTO_OFF_SYNC_INTERVAL_MS);
    }
  } catch (error) {
    // 读 alarm 失败只说明这一屏读不到落点，不代表刚才那次写入失败——它已经落盘了
    logger.debug('Read auto-off alarm after setting failed:', error);
    return { status: 'unconfirmed' };
  }

  logger.debug('Auto-off alarm not re-armed within the sync budget');
  return { status: 'unconfirmed' };
}
