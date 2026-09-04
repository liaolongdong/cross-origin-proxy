import { ref, computed, onMounted, onUnmounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';
import { generateId } from '@/utils/generateId';
import { STORAGE_KEYS } from '@/utils/constants';
import { logger } from '@/utils/logger';
import { findConflictingRule as findConflictingRulePure, computeShadowedRuleIds } from '@/utils/ruleConflicts';

export function useRuleManagement() {
  const rules = ref<ProxyRule[]>([]);
  const enabled = ref(false);
  const loading = ref(true);

  /**
   * 在已启用规则集中查找与待写入规则冲突的更高优先级规则（见 utils/ruleConflicts）
   */
  function findConflictingRule(
    ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>,
    excludeId?: string,
  ): ProxyRule | null {
    return findConflictingRulePure(
      rules.value,
      { matchPattern: ruleData.matchPattern, matchType: ruleData.matchType, priority: ruleData.priority ?? Infinity },
      excludeId,
    );
  }

  /** 计算被同模式更高优先级规则遮蔽的规则 ID 集合（见 utils/ruleConflicts） */
  const shadowedRuleIds = computed(() => computeShadowedRuleIds(rules.value));

  async function fetchConfig() {
    loading.value = true;
    try {
      const config: ProxyConfig | undefined = await chrome.runtime.sendMessage({
        type: MessageType.GET_PROXY_CONFIG,
      });
      // SW 异常时响应可能为非标结构，仅接受含数组 rules 的配置
      if (!config || !Array.isArray(config.rules)) return;
      rules.value = config.rules;
      enabled.value = config.enabled;
    } catch (error) {
      logger.error('Failed to fetch config:', error);
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

  /** 批量新增（单条消息一次写入，避免逐条 sendMessage 触发多次 DNR 重建） */
  async function batchAddRules(
    ruleDataList: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>[],
  ): Promise<ProxyRule[]> {
    if (ruleDataList.length === 0) return [];
    const now = Date.now();
    const newRules: ProxyRule[] = ruleDataList.map(data => ({
      ...data,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    }));
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.BATCH_ADD_RULES,
      data: { rules: newRules },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'BATCH_ADD_RULES_FAILED');
    }
    rules.value.push(...newRules);
    return newRules;
  }

  async function updateRule(ruleId: string, updates: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>) {
    const existingRule = rules.value.find(r => r.id === ruleId);
    if (!existingRule) return;
    // 整体替换：不与旧规则合并，updates 未包含的可选字段（如已关闭的 mock/拦截开关）即被清除
    const updatedRule: ProxyRule = {
      ...updates,
      id: ruleId,
      createdAt: existingRule.createdAt,
      updatedAt: Date.now(),
    };
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.UPDATE_RULE,
      data: { rule: updatedRule },
    });
    // 后台写入失败时不做乐观更新，抛错交由调用方提示
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'UPDATE_RULE_FAILED');
    }
    const index = rules.value.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      rules.value[index] = updatedRule;
    }
  }

  async function deleteRule(ruleId: string) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.DELETE_RULE,
      data: { ruleId },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'DELETE_RULE_FAILED');
    }
    rules.value = rules.value.filter(r => r.id !== ruleId);
  }

  async function toggleRule(ruleId: string, enabled: boolean) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_RULE,
      data: { ruleId, enabled },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'TOGGLE_RULE_FAILED');
    }
    const rule = rules.value.find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  /** 批量启停（单条消息一次写入，避免循环 sendMessage 触发多次 DNR 重建） */
  async function batchToggleRules(ruleIds: string[], enabled: boolean) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.BATCH_TOGGLE_RULES,
      data: { ruleIds, enabled },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'BATCH_TOGGLE_FAILED');
    }
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
    const resp: { success: boolean; error?: string; data?: unknown } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.BATCH_DELETE_RULES,
      data: { ruleIds: ids },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'BATCH_DELETE_FAILED');
    }
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
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_PROXY,
      data: { enabled: value },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'TOGGLE_PROXY_FAILED');
    }
    enabled.value = value;
  }

  // 外部配置变化同步：快捷键开关代理、环境配置加载、其他扩展页的改动
  // 都发生在后台存储层，常开的 options 页需监听变化刷新，避免状态过期
  function handleStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) {
    if (areaName === 'local' && STORAGE_KEYS.PROXY_CONFIG in changes) {
      void fetchConfig();
    }
  }

  onMounted(() => {
    void fetchConfig();
    chrome.storage.onChanged.addListener(handleStorageChanged);
  });

  onUnmounted(() => {
    chrome.storage.onChanged.removeListener(handleStorageChanged);
  });

  return {
    rules,
    enabled,
    loading,
    shadowedRuleIds,
    fetchConfig,
    addRule,
    batchAddRules,
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
