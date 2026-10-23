import { ref, watch, onMounted, type Ref } from 'vue';
import type { ProxyRule } from '@/utils/types';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import { findDnrSkippedRules } from '@/utils/dnrSupport';
import { logger } from '@/utils/logger';
import { useI18n } from '@/composables/useI18n';

/**
 * 「会被 DNR 同步跳过」的规则集合（规则 id → 原因）
 *
 * 供规则列表与 URL 测试弹窗标红：这类规则在界面上是启用状态，实际对流量零作用
 * （见 utils/dnrSupport 的说明）。判定是异步的（RE2 校验走 chrome API），
 * 因此结果是 ref 而非 computed。
 *
 * 规则数组每次变化重算一次，并丢弃过期结果：并发时后发先至会让旧快照覆盖新判定。
 *
 * 第二个返回值 `dnrSupportRead` 回答的是另一件事：**这份判定有没有真的落到过一次**。
 * 空 Map 有两种来路——「判过了，没有规则被跳过」与「还没判完 / 判的过程抛了」，
 * 而消费方（URL 匹配预演的两通道差异那一格）需要区分它们：拿「没被跳过」当「会被应用」，
 * 就会在浏览器根本不应用这条规则时断言出「网络层拿到 X」。与本仓 `statusEverRead`、
 * `logsEverRead` 同一族，只在**成功**那一次置真（失败时保持原样，不假装读到过）。
 */
export function useDnrSupport(rules: Ref<ProxyRule[]>) {
  const dnrSkippedRules = ref<Map<string, DnrSkipReason>>(new Map());
  const dnrSupportRead = ref(false);
  let checkSeq = 0;

  async function recheck() {
    const seq = ++checkSeq;
    try {
      const skipped = await findDnrSkippedRules(rules.value);
      if (seq === checkSeq) {
        dnrSkippedRules.value = skipped;
        dnrSupportRead.value = true;
      }
    } catch (error) {
      logger.error('DNR applicability check failed:', error);
    }
  }

  onMounted(recheck);
  // deep：启用开关、目标 URL 等就地修改同样决定规则是否还走 DNR
  watch(rules, recheck, { deep: true });

  return { dnrSkippedRules, dnrSupportRead };
}

/**
 * DNR 跳过原因的展示文案（列表徽章 / URL 测试弹窗 / 保存提示共用一份措辞）
 */
export function useDnrSkipText() {
  const { t } = useI18n();

  /** 单句原因，供已经自带上下文的位置使用 */
  function skipReasonText(reason: DnrSkipReason | undefined): string {
    if (!reason) return '';
    return reason === 'regexUnsupported' ? t('dnrSkippedRe2') : t('dnrSkippedSubstitution');
  }

  /** 完整告警：为什么会失效 + 怎么改能让它生效 */
  function skipReasonLines(reason: DnrSkipReason | undefined): string[] {
    if (!reason) return [];
    return [t('dnrSkippedIntro'), skipReasonText(reason), t('dnrSkippedHint')];
  }

  return { skipReasonText, skipReasonLines };
}
