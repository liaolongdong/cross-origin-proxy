import { ref, onMounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';
import { generateId } from '@/utils/generateId';

export function useRuleManagement() {
  const rules = ref<ProxyRule[]>([]);
  const enabled = ref(false);
  const loading = ref(true);

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

  /** 批量删除（单条消息一次写入，避免循环 sendMessage 触发多次 DNR 重建） */
  async function batchDeleteRules(ids: string[]) {
    await chrome.runtime.sendMessage({
      type: MessageType.BATCH_DELETE_RULES,
      data: { ruleIds: ids },
    });
    const idSet = new Set(ids);
    rules.value = rules.value.filter(r => !idSet.has(r.id));
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
    fetchConfig,
    addRule,
    updateRule,
    deleteRule,
    toggleRule,
    batchToggleRules,
    batchDeleteRules,
    toggleProxy,
  };
}
