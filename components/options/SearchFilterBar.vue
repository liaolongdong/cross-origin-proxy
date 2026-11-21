<template>
  <div class="search-filter-bar">
    <el-input
      v-model="localSearchText"
      :placeholder="t('searchRules')"
      clearable
      class="search-input"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
    </el-input>

    <!-- 命令面板的鼠标入口：只有键盘快捷键的功能等于对鼠标用户不存在 -->
    <button
      type="button"
      class="command-hint"
      :title="t('commandOpenHint')"
      :aria-label="t('commandOpenHint')"
      @click="$emit('openCommandPalette')"
    >
      {{ commandShortcutLabel }}
    </button>

    <el-select
      :model-value="statusFilter"
      :placeholder="t('filterAll')"
      class="status-select"
      @update:model-value="$emit('update:statusFilter', $event)"
    >
      <el-option
        :label="t('filterAll')"
        value=""
      />
      <el-option
        :label="t('filterEnabled')"
        value="enabled"
      />
      <el-option
        :label="t('filterDisabled')"
        value="disabled"
      />
    </el-select>

    <el-select
      :model-value="matchTypeFilter"
      :placeholder="t('filterAllMatchTypes')"
      class="match-type-select"
      clearable
      @update:model-value="$emit('update:matchTypeFilter', $event ?? '')"
    >
      <el-option
        :label="t('matchTypeWildcard')"
        value="wildcard"
      />
      <el-option
        :label="t('matchTypePrefix')"
        value="prefix"
      />
      <el-option
        :label="t('matchTypeRegex')"
        value="regex"
      />
    </el-select>

    <!--
      标签筛选：一条规则都没打过标签时整格不出现（空下拉只会让人觉得界面坏了）。
      但「已经选着标签」时也必须留着——把最后一条打过标签的规则删掉（批量删除 + 撤销窗口
      是同一条路）之后，availableTags 会空下来，而 tagsFilter 还留着那个值：不留着这一格，
      表格就停在「无匹配」上，界面上再没有任何一个能撤销这条筛选的控件。
    -->
    <el-select
      v-if="availableTags.length > 0 || tagsFilter.length > 0"
      :model-value="tagsFilter"
      multiple
      collapse-tags
      collapse-tags-tooltip
      clearable
      class="tag-select"
      :placeholder="t('filterTags')"
      @update:model-value="$emit('update:tagsFilter', $event ?? [])"
    >
      <el-option
        :label="t('filterTagsUntagged')"
        :value="UNTAGGED"
      />
      <el-option
        v-for="option in availableTags"
        :key="option.tag"
        :label="`${option.tag} (${option.count})`"
        :value="option.tag"
      />
    </el-select>

    <!-- 有勾选时出现的批量操作。整组包一层：不包的话 flex-wrap 会把「批量删除」单独甩到下一行，
         四颗本属同一件事的按钮读起来像两件 -->
    <div
      v-if="selectedCount > 0"
      class="bar-actions"
    >
      <el-button
        class="batch-action"
        :icon="Open"
        @click="$emit('batchToggle', true)"
      >
        {{ t('batchEnable') }} ({{ selectedCount }})
      </el-button>
      <el-button
        class="batch-action"
        :icon="TurnOff"
        @click="$emit('batchToggle', false)"
      >
        {{ t('batchDisable') }} ({{ selectedCount }})
      </el-button>
      <el-button
        class="batch-action"
        :icon="Switch"
        @click="$emit('batchMigrate')"
      >
        {{ t('batchMigrate') }}
      </el-button>
      <el-button
        class="batch-action"
        type="danger"
        plain
        :icon="Delete"
        @click="$emit('batchDelete')"
      >
        {{ t('batchDelete') }} ({{ selectedCount }})
      </el-button>
    </div>

    <!-- 全部启用/停用（始终可见，有规则时显示） -->
    <div
      v-if="totalRules > 0 && selectedCount === 0"
      class="bar-actions"
    >
      <el-button
        :icon="Open"
        @click="$emit('toggleAll', true)"
        >{{ t('toggleAllEnable') }}</el-button
      >
      <el-button
        :icon="TurnOff"
        @click="$emit('toggleAll', false)"
        >{{ t('toggleAllDisable') }}</el-button
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { Search, Open, TurnOff, Switch, Delete } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';
import { UNTAGGED } from '@/utils/ruleTags';

/**
 * 规则搜索筛选栏（白色圆角卡片）
 *
 * 搜索/筛选状态由父组件持有（v-model 双绑），批量按钮在有勾选行时条件显示。
 */
const props = defineProps<{
  /** 搜索关键字（名称/模式/目标 URL） */
  searchText: string;
  /** 状态筛选：'' | 'enabled' | 'disabled' */
  statusFilter: string;
  /** 匹配类型筛选：'' | 'wildcard' | 'prefix' | 'regex' */
  matchTypeFilter: string;
  /** 标签筛选（多选，任一命中；含 UNTAGGED 哨兵表示「没打标签的」）。判据在 `utils/ruleTags.ts` */
  tagsFilter: string[];
  /** 现有规则用到的标签与各自条数，按用量降序（`collectRuleTags` 的产物） */
  availableTags: { tag: string; count: number }[];
  /** 表格勾选数量（>0 时显示批量按钮） */
  selectedCount: number;
  /** 规则总数（>0 时显示全部启用/停用按钮） */
  totalRules: number;
  /** 命令面板的快捷键显示值（Mac ⌘K / 其它 Ctrl K），由容器层按平台传入 */
  commandShortcutLabel: string;
}>();

const emit = defineEmits<{
  'update:searchText': [value: string];
  'update:statusFilter': [value: string];
  'update:matchTypeFilter': [value: string];
  'update:tagsFilter': [value: string[]];
  /** 批量启用/停用勾选规则 */
  batchToggle: [enabled: boolean];
  /** 批量删除勾选规则 */
  batchDelete: [];
  /** 批量迁移勾选规则的目标 URL */
  batchMigrate: [];
  /** 全部启用/停用所有规则 */
  toggleAll: [enabled: boolean];
  /** 打开命令面板（鼠标入口） */
  openCommandPalette: [];
}>();

const { t } = useI18n();

// 本地搜索输入值 + 200ms 防抖
const localSearchText = ref(props.searchText || '');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(localSearchText, val => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit('update:searchText', val);
  }, 200);
});

// 父组件说什么，这一格就得画什么。此前它只在挂载那一刻读一次 `props.searchText`，
// 于是「筛选被外部清掉了、输入框还留着刚才那几个字」是必然结果——新加的「清除筛选」
// 那颗按钮正是这条外部通路（以后任何一处替用户重置筛选的写法都走同一条）。
// 判据只有一条：两边说的不是同一件事才动它。自己 emit 出去那一次的回声两边相等，
// 所以打字中的光标与输入法的合成态都不会被拽走。
watch(
  () => props.searchText,
  val => {
    if (val !== localSearchText.value) localSearchText.value = val;
  },
);

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<style scoped>
.search-filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cop-space-4) var(--cop-space-5);
  align-items: center;
  padding: var(--cop-space-7) var(--cop-space-8);
  margin: 0 var(--cop-space-10) var(--cop-space-7);
  background: var(--cop-bg-color);
  border-radius: var(--cop-radius-md);
  box-shadow: var(--cop-shadow-md);
}

.search-filter-bar :deep(.el-button + .el-button) {
  margin-left: 0;
}

/*
  一组动作自己是一个整体。外层那条 flex 是「筛选控件排一排」，动作组混在里面时
  `flex-wrap` 会在任意两颗之间断行——窄窗口下「批量删除」被单独甩到第二行，
  读起来像另一件事，而它和前三颗说的是同一批勾选中的规则。
  包一层之后断行只发生在组与组之间；组内仍允许折行（四颗中文按钮在 768px 下放不下），
  但折的是整组，间距与外层同源。
*/
.bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cop-space-4) var(--cop-space-5);
  align-items: center;
}

/*
  勾选一下才出现的四颗批量按钮：此前它们是凭空长出来的（第一次勾一行，整组直接跳出来），
  而「取消勾选」那一组同时消失——同一件事的两个方向都只有一半交代。
  复用 `tokens.css` 的 `cop-rise-in`（不新建关键帧、不写第二份时长表），
  时长走 `base`：这一格是被用户自己的勾选叫出来的，不是按下的跟手反馈。
  不写 fill——`both` / `forwards` 会把 `transform` 冻在末帧，而动画在级联里排在 `:hover` 之前，
  悬浮抬升会当场失效且没有任何报错。reduce 那一档由 `tokens.css` 的全局 `*` 段接住。
*/
.batch-action {
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter);
}

.search-input {
  flex: 1 1 260px;
  min-width: 220px;
}

/*
  ⌘K 的鼠标入口。画成键帽，与命令面板底部那一排 `kbd` 同一套形状：同一件事在两个界面
  不该是两种样子，而「这是个按键」比「这是个灰色小方块」更快读出来。
  高度仍留 32px、与这一排的下拉齐平——它是面板**唯一**的鼠标入口，缩成面板里那种 22px
  的小键帽等于把唯一入口藏起来。底缘那 1px 是键帽的厚度，按下时收回、本体沉 1px。
*/
.command-hint {
  flex-shrink: 0;
  height: 32px;
  padding: 0 var(--cop-space-3);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  color: var(--cop-text-color-secondary);
  cursor: pointer;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: var(--cop-radius-sm);
  box-shadow: 0 1px 0 var(--cop-border-color-light);
  transition:
    color var(--cop-duration-instant) var(--cop-ease-standard),
    border-color var(--cop-duration-instant) var(--cop-ease-standard),
    box-shadow var(--cop-duration-instant) var(--cop-ease-standard),
    transform var(--cop-duration-instant) var(--cop-ease-standard);
}

.command-hint:hover {
  color: var(--cop-primary);
  border-color: var(--cop-primary);
  box-shadow: 0 1px 0 var(--cop-primary);
}

/* 键帽沉下去那一格：这一颗说的是「按这个键」，跟手的位移比只换个颜色更像按键 */
.command-hint:active {
  box-shadow: none;
  transform: translateY(1px);
}

/* 焦点环走 outline：box-shadow 那一份已经被键帽厚度占着，写在同一处会被 :hover 整条盖掉 */
.command-hint:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 2px;
}

.status-select {
  flex-shrink: 0;
  width: 130px;
}

.match-type-select {
  flex-shrink: 0;
  width: 130px;
}

/* 标签是多选、会挤成两枚 chip + 「+N」，比那两枚单选宽一点才不用悬停才知道筛了什么 */
.tag-select {
  flex-shrink: 0;
  width: 176px;
}

@media (width <= 768px) {
  .search-filter-bar {
    flex-wrap: wrap;
    margin: 0 var(--cop-space-8) var(--cop-space-7);
  }

  .search-input {
    flex-basis: 100%;
  }
}
</style>
