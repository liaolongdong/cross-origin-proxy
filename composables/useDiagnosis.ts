import { useI18n } from '@/composables/useI18n';
import type { Diagnosis } from '@/utils/diagnosis';

/**
 * 归因结论的展示文案（URL 预演弹窗与弹窗命中预览共用一份措辞）
 *
 * 与 `useDnrSkipText()` 同一类适配器：**判据住在 `utils/diagnosis.ts`，措辞住在这里**，
 * 两边各自只有一个出口。每个分支都是一句「原因 + 下一步」，因为读者拿到「没命中」三个字
 * 是走不出去的——同一句话在两个界面说成两样，就等于多了一份判据。
 *
 * 键写成 `t('字面量')` 而不是拼出来的动态键：`tests/i18n.test.ts` 按字面量扫源码，
 * 拼出来的键它查不到，缺一条中文或英文文案就会直接把裸键名画到界面上。
 */
export function useDiagnosisText() {
  const { t } = useI18n();

  /** 把一条归因结论说成一句人话（含下一步动作） */
  function diagnosisText(diagnosis: Diagnosis): string {
    const rule = diagnosis.rule?.name ?? '';
    switch (diagnosis.code) {
      case 'noRules':
        return t('diagnosisNoRules');
      case 'proxyDisabled':
        return t('diagnosisProxyDisabled');
      case 'ruleNotApplied':
        return t('diagnosisRuleNotApplied', rule);
      case 'pageNotSynced':
        return t('diagnosisPageNotSynced', rule);
      case 'shadowedBy':
        return t('diagnosisShadowedBy', [rule, diagnosis.blocker?.name ?? '']);
      case 'disabledMatch':
        return t('diagnosisDisabledMatch', rule);
      case 'methodFiltered':
        return t('diagnosisMethodFiltered', [rule, diagnosis.rule?.methods?.join(' / ') ?? '']);
      case 'patternRejected':
        return t('diagnosisPatternRejected', rule);
      case 'noMatch':
        return t('diagnosisNoMatch');
      case 'ok':
        return diagnosis.channel === 'dnr' ? t('diagnosisOkDnr', rule) : t('diagnosisOkSw', rule);
      default:
        return '';
    }
  }

  return { diagnosisText };
}
