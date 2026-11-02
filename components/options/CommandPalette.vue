<template>
  <el-dialog
    :model-value="visible"
    :title="t('commandPaletteTitle')"
    width="560px"
    top="12vh"
    align-center
    :show-close="false"
    class="command-palette-dialog"
    @close="close"
    @closed="$emit('closed')"
    @opened="focusInput"
  >
    <input
      ref="inputRef"
      v-model="query"
      class="command-search"
      type="text"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="true"
      aria-controls="command-palette-list"
      :aria-activedescendant="activeOptionId"
      :placeholder="t('commandPalettePlaceholder')"
      :aria-label="t('commandPalettePlaceholder')"
      @keydown="handleKeydown"
    />

    <div
      id="command-palette-list"
      class="command-list"
      role="listbox"
      :aria-label="t('commandPaletteTitle')"
    >
      <template v-if="ruleItems.length > 0">
        <div class="command-group">{{ t('commandPaletteRules') }}</div>
        <button
          v-for="(item, index) in ruleItems"
          :id="optionId('rule', index)"
          :key="item.id"
          type="button"
          role="option"
          tabindex="-1"
          class="command-item"
          :class="{ 'is-active': activeIndex === index }"
          :aria-selected="activeIndex === index"
          @mouseenter="activeIndex = index"
          @click="chooseRule(item)"
        >
          <span class="command-rule-name">{{ item.name }}</span>
          <code class="command-rule-pattern">{{ item.matchPattern }}</code>
          <span
            v-if="!item.enabled"
            class="command-rule-off"
            >{{ t('filterDisabled') }}</span
          >
        </button>
      </template>

      <!-- 「规则那一半」此刻的答案形状，就排在规则那一组该在的位置上——排在命令之后，
           读起来像是在说命令，而它说的是规则 -->
      <p
        v-if="rulesNoteText && ruleItems.length === 0"
        class="command-note"
      >
        {{ rulesNoteText }}
      </p>

      <template v-if="actionItems.length > 0">
        <div class="command-group">{{ t('commandPaletteActions') }}</div>
        <button
          v-for="(item, index) in actionItems"
          :id="optionId('action', index)"
          :key="item.key"
          type="button"
          role="option"
          tabindex="-1"
          class="command-item"
          :class="{ 'is-active': activeIndex === ruleItems.length + index }"
          :aria-selected="activeIndex === ruleItems.length + index"
          @mouseenter="activeIndex = ruleItems.length + index"
          @click="chooseAction(item.key)"
        >
          {{ item.label }}
        </button>
      </template>

      <p
        v-if="ruleItems.length === 0 && actionItems.length === 0 && !rulesNoteText"
        class="command-empty"
      >
        {{ t('commandPaletteEmpty') }}
      </p>
    </div>

    <div
      class="command-footer"
      aria-hidden="true"
    >
      ↑ ↓ · Enter · Esc
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { ProxyRule } from '@/utils/types';
import type { CommandPaletteAction, CommandPaletteActionEntry } from '@/utils/commandPalette';
import { MAX_COMMAND_RULE_RESULTS } from '@/utils/commandPalette';
import { ruleMatchesKeyword } from '@/utils/ruleSearch';
import { useI18n } from '@/composables/useI18n';

/**
 * 命令面板
 *
 * 只做「找规则 / 开一个地方」：不出现删除、清空、批量这类破坏性动作，不写 storage、不发消息。
 * 规则关键字判据与主搜索共用 `ruleMatchesKeyword`；排序沿用规则列表当前顺序（优先级），
 * 不在这里另做一套打分。
 */
const props = defineProps<{
  visible: boolean;
  rules: ProxyRule[];
  /** 有筛选时「清除筛选」才出现 */
  filterActive: boolean;
  /**
   * 首屏那一次配置往返是否还在路上（与 `everRead` 一起用，判据同 `RuleTable`：
   * 已经读到过一次之后的刷新不该再闪一句「正在读取」）
   */
  rulesLoading: boolean;
  /** 这一次打开页面后是否至少成功读到过一次规则 */
  rulesEverRead: boolean;
  /** 读到的是失败（抛错 / 信封不成形状）——手里那份空列表不是答案 */
  rulesReadFailed: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  'edit-rule': [rule: ProxyRule];
  action: [action: CommandPaletteAction];
  closed: [];
}>();

const { t } = useI18n();
const query = ref('');
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const actionEntries = computed<CommandPaletteActionEntry[]>(() => {
  const entries: CommandPaletteActionEntry[] = [
    { key: 'add-rule', label: t('addRule') },
    { key: 'logs', label: t('tabLogs') },
    { key: 'url-test', label: t('urlTest') },
    { key: 'import-export', label: t('importExportConfig') },
    { key: 'profiles', label: t('openProfiles') },
    { key: 'settings', label: t('tabSettings') },
    { key: 'self-check', label: t('actionSelfCheck') },
    { key: 'about', label: t('about') },
    { key: 'focus-search', label: t('commandFocusSearch') },
    { key: 'clear-filters', label: t('clearFilters') },
  ];
  return props.filterActive ? entries : entries.filter(entry => entry.key !== 'clear-filters');
});

// 空查询只列动作；输入后才搜规则（200 条规则全铺出来等于噪声）
const ruleItems = computed(() => {
  if (!query.value) return [];
  return props.rules.filter(rule => ruleMatchesKeyword(rule, query.value)).slice(0, MAX_COMMAND_RULE_RESULTS);
});

const actionItems = computed(() => {
  const keyword = query.value.toLowerCase();
  return actionEntries.value.filter(entry => !keyword || entry.label.toLowerCase().includes(keyword));
});

/**
 * 「规则那半此刻没有结果」要说哪一句
 *
 * 三种事实三句话：没搜规则（空串，无话要说）、首屏那一次还在路上、以及读到了失败。
 * 判据与 `RuleTable` 同一条（`loading && !everRead`）——已经读到过一次之后的刷新不该再闪一句「正在读取」。
 *
 * 存在的理由：「没有匹配的规则」这句话只有真的搜过之后才有资格说。SW 冷启动时立刻按 ⌘K 打字，
 * 手里那份 `rules` 空数组既不是「一条规则都没有」也不是「都没匹配上」，它是什么都还没说；
 * 读失败那一档更直白——同一屏的规则表正在说「暂时读不到」，面板却指着同一条空列表说「没匹配」，
 * 两句话并排就是本仓反复消灭的那类自相矛盾。
 */
const rulesNoteText = computed(() => {
  if (!query.value) return '';
  if (props.rulesReadFailed) return t('readFailed');
  if (props.rulesLoading && !props.rulesEverRead) return t('commandPaletteRulesReading');
  return '';
});

const flatLength = computed(() => ruleItems.value.length + actionItems.value.length);

const activeOptionId = computed(() => {
  if (activeIndex.value < ruleItems.value.length) return optionId('rule', activeIndex.value);
  const actionIndex = activeIndex.value - ruleItems.value.length;
  return actionItems.value[actionIndex] ? optionId('action', actionIndex) : undefined;
});

function optionId(kind: 'rule' | 'action', index: number): string {
  return `command-option-${kind}-${index}`;
}

function close() {
  emit('update:visible', false);
}

/**
 * 进场补焦那枚定时器
 *
 * 只允许一枚在途：下一次补焦先掐掉上一枚，卸载时一并掐掉。EP 的焦点还原与进场动画谁先落地
 * 不保证，所以那 80ms 的兜底必须有，但叠着来就是同一帧里好几个回调互相抢焦点。
 */
let focusTimer: number | undefined;

function focusInput() {
  // EP 的焦点陷阱在进场时会把焦点放到 dialog 容器上；过一拍再抢给搜索框，让键盘真正落在输入处。
  void nextTick(() => inputRef.value?.focus());
  if (focusTimer !== undefined) window.clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    focusTimer = undefined;
    if (props.visible) inputRef.value?.focus();
  }, 80);
}

function reset() {
  query.value = '';
  activeIndex.value = 0;
  // 覆盖「分片取回前已经 visible」那条挂载分支：那一路不会有 `@opened`，只能在这里补
  void nextTick(focusInput);
}

onUnmounted(() => {
  if (focusTimer !== undefined) window.clearTimeout(focusTimer);
});

// 分片可能带着 visible === true 挂载（键盘在分片取回前按下），所以必须 immediate
watch(
  () => props.visible,
  visible => {
    if (visible) reset();
  },
  { immediate: true },
);

watch(query, () => {
  activeIndex.value = 0;
});

watch(flatLength, length => {
  if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1);
});

function move(delta: number) {
  const length = flatLength.value;
  if (length === 0) return;
  activeIndex.value = (activeIndex.value + delta + length) % length;
  void nextTick(() => {
    const id = activeOptionId.value;
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  });
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    activeIndex.value = 0;
  } else if (event.key === 'End') {
    event.preventDefault();
    activeIndex.value = Math.max(0, flatLength.value - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runActive();
  }
}

function runActive() {
  if (activeIndex.value < ruleItems.value.length) {
    const rule = ruleItems.value[activeIndex.value];
    if (rule) chooseRule(rule);
    return;
  }
  const action = actionItems.value[activeIndex.value - ruleItems.value.length];
  if (action) chooseAction(action.key);
}

function chooseRule(rule: ProxyRule) {
  close();
  emit('edit-rule', rule);
}

function chooseAction(action: CommandPaletteAction) {
  close();
  emit('action', action);
}
</script>

<style scoped>
.command-palette-dialog :deep(.el-dialog__body) {
  padding-top: 8px;
}

.command-search {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  font: inherit;
  color: inherit;
  outline: none;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.command-search:focus {
  border-color: var(--cop-primary);
  box-shadow: 0 0 0 3px rgb(var(--cop-primary-rgb) / 12%);
}

.command-list {
  max-height: 52vh;
  margin-top: 12px;
  overflow-y: auto;
}

.command-group {
  padding: 8px 8px 4px;
  font-size: 11px;
  color: var(--cop-text-color-secondary);
}

.command-item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 9px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
}

.command-item.is-active {
  background: var(--cop-primary-bg);
}

.command-rule-name {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-rule-pattern {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  white-space: nowrap;
}

.command-rule-off {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-color-danger, #f56c6c);
}

.command-empty {
  padding: 28px 0;
  margin: 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

/* 「规则那半没说上话」那一句：比空态矮一档，因为它是补话不是主句 */
.command-note {
  padding: 12px 8px;
  margin: 0;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

.command-footer {
  padding-top: 10px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--cop-text-color-placeholder);
  text-align: right;
  border-top: 1px solid var(--cop-border-color-light);
}
</style>
