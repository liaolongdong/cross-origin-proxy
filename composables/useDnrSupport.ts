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
 */
export function useDnrSupport(rules: Ref<ProxyRule[]>) {
  const dnrSkippedRules = ref<Map<string, DnrSkipReason>>(new Map());
  let checkSeq = 0;

  async function recheck() {
    const seq = ++checkSeq;
    try {
      const skipped = await findDnrSkippedRules(rules.value);
      if (seq === checkSeq) dnrSkippedRules.value = skipped;
    } catch (error) {
      logger.error('DNR applicability check failed:', error);
    }
  }

  onMounted(recheck);
  // deep：启用开关、目标 URL 等就地修改同样决定规则是否还走 DNR
  watch(rules, recheck, { deep: true });

  return { dnrSkippedRules };
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
