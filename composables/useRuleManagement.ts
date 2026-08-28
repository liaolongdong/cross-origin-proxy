import { ref, computed, onMounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';
import { generateId } from '@/utils/generateId';

export function useRuleManagement() {
  const rules = ref<ProxyRule[]>([]);
  const enabled = ref(false);
  const loading = ref(true);

  /**
   * 查找与给定规则匹配模式冲突的更高优先级规则
   * 返回第一个 matchPattern + matchType 相同且 priority 更小的已启用规则
   */
  function findConflictingRule(
    ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>,
    excludeId?: string,
  ): ProxyRule | null {
    const sorted = [...rules.value]
      .filter(r => r.enabled && r.id !== excludeId)
      .sort((a, b) => a.priority - b.priority);

    for (const existing of sorted) {
      if (
        existing.matchPattern === ruleData.matchPattern &&
        existing.matchType === ruleData.matchType &&
        existing.priority < (ruleData.priority ?? Infinity)
      ) {
        return existing;
      }
    }
    return null;
  }

  /** 计算被更高优先级同模式规则遮蔽的规则 ID 集合 */
  const shadowedRuleIds = computed(() => {
    const sorted = [...rules.value]
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    const seen = new Map<string, string>();
    const shadowed = new Set<string>();

    for (const rule of sorted) {
      const key = `${rule.matchType}::${rule.matchPattern}`;
      if (seen.has(key)) {
        shadowed.add(rule.id);
      } else {
        seen.set(key, rule.id);
      }
    }
    return shadowed;
  });

  async function fetchConfig() {
    loading.value = true;
    try {
      const config: ProxyConfig = await chrome.runtime.sendMessage({
        type: MessageType.GET_PROXY_CONFIG,
      });
      rules.value = config.rules;
      enabled.value = config.enabled;
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      loading.value = false;
    }
  }

  async function addRule(ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProxyRule> {
    const now = Date.now();
    const rule: ProxyRule = {
      ...ruleData,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.ADD_RULE,
      data: { rule },
    });
    // 后台写入失败（如超过 MAX_RULES 上限）时不做乐观更新，抛错交由调用方提示
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'ADD_RULE_FAILED');
    }
    rules.value.push(rule);
    return rule;
  }

  async function updateRule(ruleId: string, updates: Partial<ProxyRule>) {
    const existingRule = rules.value.find(r => r.id === ruleId);
    if (!existingRule) return;
    const updatedRule: ProxyRule = { ...existingRule, ...updates, updatedAt: Date.now() };
    await chrome.runtime.sendMessage({
      type: MessageType.UPDATE_RULE,
      data: { rule: updatedRule },
    });
    const index = rules.value.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      rules.value[index] = updatedRule;
    }
  }

  async function deleteRule(ruleId: string) {
    await chrome.runtime.sendMessage({
      type: MessageType.DELETE_RULE,
      data: { ruleId },
    });
    rules.value = rules.value.filter(r => r.id !== ruleId);
  }

  async function toggleRule(ruleId: string, enabled: boolean) {
    await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_RULE,
      data: { ruleId, enabled },
    });
    const rule = rules.value.find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  /** 批量启停（单条消息一次写入，避免循环 sendMessage 触发多次 DNR 重建） */
  async function batchToggleRules(ruleIds: string[], enabled: boolean) {
    await chrome.runtime.sendMessage({
      type: MessageType.BATCH_TOGGLE_RULES,
      data: { ruleIds, enabled },
    });
    const idSet = new Set(ruleIds);
    rules.value.forEach(rule => {
      if (idSet.has(rule.id)) rule.enabled = enabled;
    });
  }

  /** 全部启用/停用所有规则 */
  async function toggleAllRules(enabled: boolean) {
    const allIds = rules.value.map(r => r.id);
    if (allIds.length === 0) return;
    await batchToggleRules(allIds, enabled);
  }

  /** 批量删除（单条消息一次写入，避免循环 sendMessage 触发多次 DNR 重建） */
  async function batchDeleteRules(ids: string[]) {
    await chrome.runtime.sendMessage({
      type: MessageType.BATCH_DELETE_RULES,
      data: { ruleIds: ids },
    });
    const idSet = new Set(ids);
    rules.value = rules.value.filter(r => !idSet.has(r.id));
  }

  /** 拖拽排序（单条消息一次写入）：按 orderedIds 重排本地数组并重写 priority */
  async function reorderRules(orderedIds: string[]) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.REORDER_RULES,
      data: { orderedIds },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'REORDER_RULES_FAILED');
    }
    const byId = new Map(rules.value.map(r => [r.id, r]));
    const idSet = new Set(orderedIds);
    const reordered: ProxyRule[] = [];
    for (const id of orderedIds) {
      const rule = byId.get(id);
      if (rule) reordered.push(rule);
    }
    for (const rule of rules.value) {
      if (!idSet.has(rule.id)) reordered.push(rule);
    }
    reordered.forEach((rule, index) => {
      rule.priority = index + 1;
    });
    rules.value = reordered;
  }

  async function toggleProxy(value: boolean) {
    await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_PROXY,
      data: { enabled: value },
    });
    enabled.value = value;
  }

  onMounted(fetchConfig);

  return {
    rules,
    enabled,
    loading,
    shadowedRuleIds,
    fetchConfig,
    addRule,
    updateRule,
    deleteRule,
    toggleRule,
    batchToggleRules,
    toggleAllRules,
    batchDeleteRules,
    reorderRules,
    toggleProxy,
    findConflictingRule,
  };
}
