<template>
  <div class="rule-table-card">
    <!-- 四块面板占同一个位置，换起来本来是一次硬切：空态 / 读不到 / 无匹配 / 表格之间给一次
         先退后换的交接（`mode="out-in"`），新面板不再叠在旧面板的高度上把卡片撑一下。 -->
    <Transition
      name="panel-swap"
      mode="out-in"
    >
      <!-- 首轮读取还在路上。这一格的存在只为一件事：**不再替用户下结论**。
           在它之前，打开配置页那一瞬间画的是空态引导卡——那时 `rules` 还是空数组、
           也没有读取失败，而用户手上完全可能有三十条规则，那张卡正邀请他「新增」或
           「重新导入」本来就在的东西。骨架说的就是眼前这一件事实：还没读到。
           它也不会一直挂着：`fetchConfig` 的 `finally` 让 `loading` 在失败时同样落回 false，
           而 `configEverRead` 只在采纳成功时置真，于是「第一次读就失败」立刻换成下面那一格——
           「读不到」不许画成「还在加载」，与本仓「读不到 ≠ 没有」同一条规矩的两个方向。 -->
      <TableSkeleton
        v-if="firstReadPending"
        key="table-skeleton"
        :label="t('rulesSkeletonA11y')"
        :columns="SKELETON_COLUMNS"
        :rows="SKELETON_ROW_COUNT"
      />

      <!-- 读取失败：排在空态引导**之前**。首轮 `GET_PROXY_CONFIG` 失败时 `rules` 本来就是空的，
           若不先问这一句，用户看到的就是一张「新增规则 / 导入配置」的引导卡——可他可能本来有
           三十条，于是这张卡主动邀请他去重复创建或重新导入。口径与同页 DNR 那一格一致：
           「不确定」绝不画成「没有」。 -->
      <div
        v-else-if="rules.length === 0 && readFailed"
        key="read-failed"
        class="read-failed"
      >
        <p class="read-failed-text">{{ t('readFailed') }}</p>
        <el-button
          size="small"
          @click="$emit('refresh')"
        >
          {{ t('refresh') }}
        </el-button>
      </div>

      <!-- 空状态引导（确认过存储里就是没有规则） -->
      <EmptyGuide
        v-else-if="rules.length === 0 && !hasAnyRules"
        key="empty-guide"
        @add-rule="$emit('add')"
        @import-config="$emit('importConfig')"
        @use-template="data => $emit('useTemplate', data)"
      />

      <!-- 筛选无结果。此前这一格借用的是 `noMatch`——那句写的是「规则不匹配此 URL」，
           它的读者是 URL 测试弹窗与规则表单里那条「测试这条 pattern」的临时规则；
           而这一格压根没有 URL 参与：`rules` 是筛选后的、`hasAnyRules` 是筛选前的总数，
           能走到这里就说明**搜索/状态/类型/标签这四格里有非空的那几格把行全筛掉了**。
           说错了话之外还没有出口——四格里只有两格带 ×，读者得自己回想刚才动过哪一格。
           所以措辞按「谁筛的」说，并把出口摆在失败发生的地方（与产品站 FAQ 零命中那同一条）。
           不另写一份判据：这里不重新问「有没有筛选在场」，只把上面那条早退的形状说出来。 -->
      <div
        v-else-if="rules.length === 0"
        key="no-match"
        class="no-match"
      >
        <p>
          {{ searchText.trim() ? t('filterNoMatchKeyword', [searchText.trim()]) : t('filterNoMatch') }}
        </p>
        <el-button
          size="small"
          @click="$emit('clearFilters')"
        >
          {{ t('clearFilters') }}
        </el-button>
      </div>

      <!--
        规则表格
        `el-table-column` 的默认插槽把 `row` 报成 Element Plus 的 `DefaultRow`
        （= `Record<PropertyKey, any>`，索引签名不满足 `ProxyRule` 的必需属性），而这里的
        数据源 `:data="rules"` 是 `ProxyRule[]`。所以每个把整行交给脚本/事件的落点都写一次
        `row as ProxyRule`：纯类型断言、编译后不存在，`row.xxx` 的属性名访问不受影响。
      -->
      <el-table
        v-else
        key="rule-table"
        ref="tableRef"
        v-loading="loading"
        :data="rules"
        :row-class-name="rowClassName"
        row-key="id"
        class="rule-table"
        @selection-change="(selection: ProxyRule[]) => $emit('selectionChange', selection)"
        @dragover.prevent="onTableDragOver"
        @drop.prevent="onTableDrop"
      >
        <el-table-column
          type="selection"
          width="48"
          :reserve-selection="true"
        />
        <el-table-column
          width="36"
          align="center"
        >
          <template #header>
            <el-tooltip
              :content="t('dragToReorder')"
              placement="top"
            >
              <span class="drag-header-icon">⠿</span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <span
              class="drag-handle"
              draggable="true"
              @dragstart="onDragStart($event, row as ProxyRule)"
              @dragend="onDragEnd"
              >⠿</span
            >
          </template>
        </el-table-column>
        <el-table-column
          prop="name"
          :label="t('colName')"
          :min-width="narrowCols ? 100 : compactCols ? 140 : 120"
        >
          <template #default="{ row }">
            <span class="rule-name-cell">
              <HighlightText
                :text="row.name"
                :keyword="searchText"
                :title="row.name"
              />
              <el-tooltip
                v-if="shadowedRuleIds.has(row.id)"
                :content="t('conflictWarningTitle')"
                placement="top"
              >
                <span class="shadowed-indicator">!</span>
              </el-tooltip>
              <el-tooltip
                v-if="dnrSkipReason(row.id)"
                placement="top"
              >
                <template #content>
                  <div class="dnr-skip-tip">
                    <p
                      v-for="(line, index) in skipReasonLines(dnrSkipReason(row.id))"
                      :key="index"
                    >
                      {{ line }}
                    </p>
                  </div>
                </template>
                <span class="dnr-dead-tag">{{ t('dnrSkippedTag') }}</span>
              </el-tooltip>
              <!-- 标签最多露两枚，其余收成 +N（悬停给全表）：一行的信息密度上限比"看全"重要 -->
              <span
                v-if="rowTags(row).length > 0"
                class="rule-tags"
                :title="rowTags(row).join(' · ')"
              >
                <span
                  v-for="tag in rowTags(row).slice(0, ROW_TAG_VISIBLE)"
                  :key="tag"
                  class="rule-tag"
                  >{{ tag }}</span
                >
                <span
                  v-if="rowTags(row).length > ROW_TAG_VISIBLE"
                  class="rule-tag rule-tag--more"
                  >+{{ rowTags(row).length - ROW_TAG_VISIBLE }}</span
                >
              </span>
              <span class="rule-badges">
                <el-tooltip
                  v-if="
                    showsHttpOnlyBadge(row as ProxyRule) &&
                    row.headerOverrides &&
                    Object.keys(row.headerOverrides).length > 0
                  "
                  :content="t('hasHeaderOverrides')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--h">H</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.sendCredentials === true"
                  :content="t('hasSendCredentials')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--c">C</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.requestBodyOverride"
                  :content="t('hasBodyOverride')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--b">B</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.responseOverrides"
                  :content="t('hasResponseOverrides')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--r">R</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.mockResponse"
                  :content="t('hasMockResponse')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--m">M</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.delayMs"
                  :content="t('hasDelay')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--d">D</span>
                </el-tooltip>
                <el-tooltip
                  v-if="row.blocked"
                  :content="t('hasBlocked')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--x">X</span>
                </el-tooltip>
                <el-tooltip
                  v-if="showsHttpOnlyBadge(row as ProxyRule) && row.retryCount"
                  :content="t('hasRetry')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--re">Re</span>
                </el-tooltip>
                <el-tooltip
                  v-if="isWsRule(row as ProxyRule)"
                  :content="t('wsRuleHint')"
                  placement="top"
                >
                  <span class="rule-badge rule-badge--ws">WS</span>
                </el-tooltip>
              </span>
            </span>
          </template>
        </el-table-column>
        <el-table-column
          prop="matchPattern"
          :label="t('colMatchPattern')"
          :min-width="narrowCols ? 160 : compactCols ? 190 : 200"
        >
          <template #default="{ row }">
            <HighlightText
              :text="row.matchPattern"
              :keyword="searchText"
              :title="row.matchPattern"
            />
          </template>
        </el-table-column>
        <el-table-column
          v-if="!compactCols"
          prop="matchType"
          :label="t('colMatchType')"
          width="100"
          align="center"
        >
          <template #default="{ row }">
            <el-tag
              :type="matchTypeTagType(row.matchType)"
              size="small"
            >
              {{ matchTypeLabel(row.matchType) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="targetUrl"
          :label="t('colTargetUrl')"
          :min-width="narrowCols ? 160 : compactCols ? 190 : 200"
        >
          <template #default="{ row }">
            <HighlightText
              :text="row.targetUrl"
              :keyword="searchText"
              :title="row.targetUrl"
            />
          </template>
        </el-table-column>
        <el-table-column
          v-if="!narrowCols"
          prop="priority"
          :label="t('colPriority')"
          width="80"
          align="center"
        />
        <el-table-column
          v-if="!narrowCols"
          :label="t('hitCountLabel')"
          width="96"
          align="center"
        >
          <template #default="{ row }">
            <span
              v-if="hitCells[row.id]"
              class="hit-stats-pair"
            >
              <el-tooltip
                :content="hitCells[row.id].netTip"
                placement="top"
              >
                <span :class="['hit-count-badge', hitCells[row.id].netUnknown && 'hit-count-unknown']">
                  <span
                    :key="hitCells[row.id].net"
                    class="hit-count-digit"
                    >{{ hitCells[row.id].net }}</span
                  >
                </span>
              </el-tooltip>
              <el-tooltip
                :content="hitCells[row.id].extTip"
                placement="top"
              >
                <span
                  :class="[
                    'hit-count-badge',
                    'hit-count-badge--ext',
                    hitCells[row.id].extUnknown && 'hit-count-unknown',
                  ]"
                >
                  <span
                    :key="hitCells[row.id].ext"
                    class="hit-count-digit"
                    >{{ hitCells[row.id].ext }}</span
                  >
                </span>
              </el-tooltip>
            </span>
            <span
              v-else
              class="hit-count-zero"
              >-</span
            >
          </template>
        </el-table-column>
        <el-table-column
          :label="t('colStatus')"
          width="80"
          align="center"
        >
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              size="small"
              :aria-label="t('enableRuleA11y', row.name)"
              @change="(val: boolean | string | number) => $emit('toggle', row.id, val as boolean)"
            />
          </template>
        </el-table-column>
        <el-table-column
          :label="t('colActions')"
          :width="narrowCols ? 120 : 140"
          align="center"
          header-align="center"
          :fixed="narrowCols ? false : 'right'"
        >
          <template #default="{ row }">
            <div class="row-actions">
              <el-tooltip
                :content="t('edit')"
                placement="top"
                :show-after="400"
              >
                <el-button
                  circle
                  size="small"
                  :icon="EditPen"
                  :aria-label="t('editRuleA11y', row.name)"
                  @click="$emit('edit', row as ProxyRule)"
                />
              </el-tooltip>
              <el-tooltip
                :content="t('duplicateRule')"
                placement="top"
                :show-after="400"
              >
                <el-button
                  circle
                  size="small"
                  :icon="CopyDocument"
                  :aria-label="t('duplicateRuleA11y', row.name)"
                  @click="$emit('duplicate', row as ProxyRule)"
                />
              </el-tooltip>
              <el-popconfirm
                :title="t('confirmDeleteRule')"
                :confirm-button-text="t('confirm')"
                :cancel-button-text="t('cancel')"
                @confirm="handleDelete(row as ProxyRule)"
              >
                <template #reference>
                  <el-button
                    circle
                    size="small"
                    type="danger"
                    plain
                    :icon="Delete"
                    :aria-label="t('deleteRuleA11y', row.name)"
                  />
                </template>
              </el-popconfirm>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditPen, CopyDocument, Delete } from '@element-plus/icons-vue';
import type { ProxyRule } from '@/utils/types';
import type { TableInstance } from 'element-plus';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import type { RuleHitStats } from '@/utils/ruleStats';
import { isDnrCountReadable, type DnrSampleState } from '@/utils/dnrSample';
import { ROW_STAGGER_MAX_DELAY_MS } from '@/utils/constants';
import { useI18n } from '@/composables/useI18n';
import { useDnrSkipText } from '@/composables/useDnrSupport';
import { isSimpleRule, isWebSocketRule } from '@/utils/urlMatcher';
import { visibleTags } from '@/utils/ruleTags';
import type { FlipRect } from '@/utils/transitions';
import { applyFlip, motionTokenToMs, prefersReducedMotion, readMotionToken, readRects } from '@/utils/transitions';
import { flipFirstRect, freshRowIds, isSameRowSet, rowMotionAffordable, type RowPosition } from '@/utils/rowMotion';
import EmptyGuide from './EmptyGuide.vue';
import HighlightText from './HighlightText.vue';
import TableSkeleton from './TableSkeleton.vue';

/** 一行上能露出的标签数；其余收成 +N，全表走悬停（一行的高度上限比"看全所有标签"重要） */
const ROW_TAG_VISIBLE = 2;

/** 标签从 storage 来，可能是被手改过的任何形状：非数组/非字符串一律当没有（判据同 `configRules()`） */
function rowTags(row: unknown): string[] {
  return visibleTags((row as { tags?: unknown }).tags);
}

/**
 * 规则表格（白色圆角卡片容器）
 *
 * 展示型组件：搜索/筛选已上移到 SearchFilterBar，本组件只接收筛选后的规则。
 * 交互签名：circle 小按钮 + 400ms 延迟 tooltip、新增行下落动画、删除行右滑出屏。
 */
const props = defineProps<{
  /** 筛选后的规则列表 */
  rules: ProxyRule[];
  loading: boolean;
  hasAnyRules: boolean;
  /**
   * 这一次打开页面有没有成功采纳过至少一份配置读数（规则为空也算读到过）
   *
   * 骨架屏的一半判据。没有它，「刷新时 `loading` 又置真」会把一张有三十行的表格换成骨架——
   * 而那一次用户是**看着**它变空的。与 `configReadFailed` 分着说两件事：这里管「还没读到」，
   * 那边管「读了但没读到东西」。
   */
  everRead: boolean;
  /**
   * 上一次「读存储」失败（回包形状不对或消息抛错）
   *
   * 与 `hasAnyRules` 一起把「确实没有规则」和「读不到有没有规则」分开画：前者给空态引导卡，
   * 后者给一句提示 + 刷新，见模板里排在引导卡之前的那一格。
   */
  readFailed?: boolean;
  /** 最近新增规则 id（进场动画用） */
  highlightRuleId?: string | null;
  /** 搜索关键字（用于高亮，以及「筛选无结果」那一格点名是谁筛空的） */
  searchText: string;
  /** 规则命中统计（ruleId → 分通道读数，**不相加**） */
  hitStats: Map<string, RuleHitStats>;
  /** 网络层采样的五态：决定那一格画数字、「—」还是提示「不知道 / 没有这类规则」 */
  dnrStatsState: DnrSampleState;
  /** 被更高优先级同模式规则遮蔽的规则 ID 集合 */
  shadowedRuleIds: Set<string>;
  /** 走 DNR 通道但不会被浏览器应用的规则（ruleId → 原因） */
  dnrSkippedRules: Map<string, DnrSkipReason>;
}>();

const emit = defineEmits<{
  add: [];
  edit: [rule: ProxyRule];
  duplicate: [rule: ProxyRule];
  delete: [ruleId: string];
  toggle: [ruleId: string, enabled: boolean];
  importConfig: [];
  selectionChange: [selection: ProxyRule[]];
  useTemplate: [ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>];
  reorder: [fromId: string, toId: string];
  /** 「读取失败」那一格里的刷新按钮 */
  refresh: [];
  /** 「筛选无结果」那一格里的清除筛选按钮（四格筛选由父组件持有，这里只交出一个意图） */
  clearFilters: [];
}>();

const { t } = useI18n();
const { skipReasonLines } = useDnrSkipText();

/**
 * 骨架屏画几行
 *
 * 与真实行数无关（此刻手上根本没有行数），取的是一个「不至于让人以为表是空的、
 * 又不会在读完换成 3 行时往下跳一大截」的中间值。
 */
const SKELETON_ROW_COUNT = 5;

/** 骨架的五格：勾选框 + 拖拽把手那一列的宽度、名字、匹配模式、目标、操作按钮 */
const SKELETON_COLUMNS = [{ width: '60px' }, { width: '22%' }, { flex: 1 }, { flex: 1.4 }, { width: '76px' }];

/** 首轮读取还在路上：只在这一段画骨架，读到一次之后就再也不画（见 props.everRead 的注释） */
const firstReadPending = computed(() => props.loading && !props.everRead);

/**
 * 命中列的两枚读数（分通道，**不相加**：网络层是近 5 分钟滚动窗口，扩展通道是自
 * 上次配置变更或后台重启以来的累计，相加出来的数不属于任何一段时间）。
 *
 * 每格只画属于自己那条通道的数：走网络层的规则，后台那一格永远是 0，而那个 0 不是
 * 「一次都没走后台」，是「这条规则根本不在后台执行」——反向同理。所以两格各自先问
 * 「该不该有读数」，再问「读到了没有」；全局采样状态只决定网络层那一格读没读到。
 * 只收录「至少说得出一个数」的规则：两格都是「—」时维持原来的「-」，避免整列噪音。
 */
const hitCells = computed(() => {
  const state = props.dnrStatsState;
  const readable = isDnrCountReadable(state);
  const netTipByState =
    state === 'notApplicable'
      ? t('statsNotApplicable')
      : state === 'stale'
        ? t('hitStatsStale')
        : readable
          ? t('hitStatsNetTip')
          : t('statsUnavailable');
  const channelById = new Map(props.rules.map(rule => [rule.id, isSimpleRule(rule)] as const));

  const cells: Record<
    string,
    { net: string; ext: string; netTip: string; extTip: string; netUnknown: boolean; extUnknown: boolean }
  > = {};
  for (const [ruleId, stat] of props.hitStats) {
    // 不在当前列表里的规则（已删或被筛掉）不会渲染，判不了通道就按扩展通道处理
    const onNet = channelById.get(ruleId) ?? false;
    const netUnknown = !onNet || !readable;
    const extUnknown = onNet;
    // 三条 `continue` 问的不是同一件事：这条问「这一行说得出话吗」，下面两条问「有没有一个
    // 非零的数可看」。少了这条，网络层规则在采样读不到、后台计数又非零时画出 `— —`——
    // 两个破折号并排，比折叠成的「-」更像故障。
    if (netUnknown && extUnknown) continue;
    if (!readable && stat.ext === 0) continue;
    if (readable && stat.net === 0 && stat.ext === 0) continue;
    cells[ruleId] = {
      net: netUnknown ? '—' : String(stat.net),
      ext: extUnknown ? '—' : String(stat.ext),
      netTip: onNet ? netTipByState : t('hitStatsNetNotApplicable'),
      extTip: onNet ? t('hitStatsExtNotApplicable') : t('hitStatsExtTip'),
      netUnknown,
      extUnknown,
    };
  }
  return cells;
});

/**
 * 表格实例：选择列开了 `reserve-selection`，勾选因此存活在表格内部而不是随 data 重建，
 * 父组件置空 `selectedRules` 并不会清掉保留的勾选。规则集被整体替换（批量删除 /
 * 导入 / 加载环境配置）时必须调用 {@link clearSelection}，否则批量操作会作用在
 * 当前筛选下看不见的规则上。
 */
const tableRef = ref<TableInstance>();

/** 清空全部勾选（含被筛选隐藏的保留项），供父组件在整体替换规则后调用 */
function clearSelection(): void {
  tableRef.value?.clearSelection();
}

defineExpose({ clearSelection });

/**
 * 窄屏列收口
 *
 * 十列合计 1100px，加上两侧 32px 外边距、卡片 8px 内边距与滚动条，视口窄于约 1200px 时
 * 表格就开始横向滚动；而操作列 `fixed="right"` 会浮在内容上，正好盖住状态开关——看起来
 * 像「开关点不动」。两档收：≤1200 收起匹配方式（模式文本本身已经说明了类型），省下的宽度
 * 让给名称列（140px），长名称不在中途折行；≤1100 再收起优先级与命中数、收窄三列的最小宽度，
 * 并把操作列改回普通列。拖拽把手始终保留：它是调整列表顺序唯一的直接入口，收起它等于在
 * 窄窗口里拿走一个功能。
 */
const compactCols = ref(false);
const narrowCols = ref(false);
let compactMql: MediaQueryList | null = null;
let narrowMql: MediaQueryList | null = null;

/** 两档断点与列宽是同一组数，改一档要连 `syncResponsiveCols` 与列上的绑定一起看 */
function syncResponsiveCols(): void {
  compactCols.value = compactMql?.matches ?? false;
  narrowCols.value = narrowMql?.matches ?? false;
  // 列是 `v-if` 增删的，布局要等这一轮渲染落地再算，否则固定列还停在旧宽度上
  void nextTick(() => tableRef.value?.doLayout());
}

onMounted(() => {
  compactMql = window.matchMedia('(max-width: 1200px)');
  narrowMql = window.matchMedia('(max-width: 1100px)');
  compactMql.addEventListener('change', syncResponsiveCols);
  narrowMql.addEventListener('change', syncResponsiveCols);
  syncResponsiveCols();
});

/**
 * 「筛选无结果」时 `v-else` 会把整个表格卸载，存活在表格内部的保留勾选随之丢失，
 * 而父组件还拿着上一份选中项。表格分支只在 `rules.length > 0` 时存在，故直接监听
 * 这个渲染条件：翻转成「不渲染」后补发一次空选择，避免计数与真实勾选分叉。
 * （`RuleTable` 在 App 里常驻，只靠 `onBeforeUnmount` 守不住筛选这条路径。）
 */
watch(
  () => props.rules.length > 0,
  (rendered, wasRendered) => {
    if (!rendered && wasRendered) emit('selectionChange', []);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  emit('selectionChange', []);
  // 错峰落位那一批的摘类名定时器：组件都要走了，没必要再让它响一次（回调里改的 ref 已经没人读）
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  compactMql?.removeEventListener('change', syncResponsiveCols);
  narrowMql?.removeEventListener('change', syncResponsiveCols);
  compactMql = null;
  narrowMql = null;
});

/** 该规则是否会被 DNR 同步跳过（返回原因，undefined 表示可正常应用） */
function dnrSkipReason(ruleId: string): DnrSkipReason | undefined {
  return props.dnrSkippedRules.get(ruleId);
}

/** matchType → el-tag 类型（静态映射，模块级避免逐行重建） */
const MATCH_TYPE_TAG_TYPES: Record<string, 'primary' | 'success' | 'warning' | 'info'> = {
  wildcard: 'primary',
  prefix: 'success',
  regex: 'warning',
};

/** 正在播放删除动画的行 id 集合 */
const leavingIds = ref<Set<string>>(new Set());

/** 拖拽中的行 id */
const dragFromId = ref<string | null>(null);
/** 拖拽悬停的目标行 id（高亮用） */
const dragOverId = ref<string | null>(null);

function onDragStart(e: DragEvent, row: ProxyRule) {
  dragFromId.value = row.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.id);
  }
}

function onDragEnd() {
  dragFromId.value = null;
  dragOverId.value = null;
}

/** 从拖拽事件目标向上找到所属行数据（事件委托，整行可作为放置目标） */
function findRowFromEvent(e: DragEvent): ProxyRule | null {
  const target = e.target as HTMLElement;
  const tr = target.closest('tr.el-table__row');
  if (tr) {
    const tbody = tr.closest('tbody');
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll('tr.el-table__row'));
    const index = rows.indexOf(tr);
    return props.rules[index] ?? null;
  }
  // 拖到最后一行下方的空白区域时，回退到最后一行
  const tbody = target.closest('tbody');
  if (tbody && props.rules.length > 0) {
    return props.rules[props.rules.length - 1];
  }
  return null;
}

function onTableDragOver(e: DragEvent) {
  const row = findRowFromEvent(e);
  const newId = row && row.id !== dragFromId.value ? row.id : null;
  if (newId !== dragOverId.value) {
    dragOverId.value = newId;
  }
}

/** 表格里的可见行（`row-key="id"` 保证重排时 Vue 挪的是同一批 DOM 节点，FLIP 才有得比） */
function visibleRowElements(): HTMLElement[] {
  const root = tableRef.value?.$el as HTMLElement | undefined;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('tr.el-table__row'));
}

/**
 * 拖拽落位后等着归位的行矩形，以及那一刻的行 id 序列。
 *
 * 为什么要等：`reorderRules` 要先走一次存储写入才换数组，DOM 到位比 emit 晚若干帧，
 * 所以位置先存着，等 `props.rules` 的顺序真的变了再放动画。两个值成对使用——id 序列
 * 用来认出「这次变化就是刚才那次拖拽」（同一批行、换了顺序）；中途发生增删或筛选变化时
 * 旧矩形已经不代表这批行，直接作废，宁可少一次动画也不能画出一次假移动。
 */
let pendingFlip: Map<HTMLElement, DOMRect> | null = null;
let pendingFlipIds: string[] = [];

function onTableDrop(e: DragEvent) {
  const fromId = dragFromId.value;
  const toRow = findRowFromEvent(e);
  const moving = Boolean(fromId && toRow && fromId !== toRow.id);
  if (moving && toRow) {
    // 位置必须在 emit 之前读：这一步之后父组件才会改数组
    const rows = visibleRowElements();
    pendingFlip = readRects(rows);
    pendingFlipIds = rows.length ? props.rules.map(rule => rule.id) : [];
  }
  if (moving && fromId && toRow) {
    emit('reorder', fromId, toRow.id);
  }
  dragFromId.value = null;
  dragOverId.value = null;
}

/** 同一批行换了顺序＝刚才那次拖拽落位；行数或行集变了就作废那份位置 */
function isPureReorder(nextIds: string[]): boolean {
  return isSameRowSet(pendingFlipIds, nextIds);
}

watch(
  () => props.rules.map(rule => rule.id).join('\u0000'),
  next => {
    const rects = pendingFlip;
    pendingFlip = null;
    if (!rects || !isPureReorder(next.split('\u0000'))) return;
    // pre-flush 的 watcher 跑在重渲染之前，再等一帧才量得到新位置
    void nextTick().then(() =>
      applyFlip(rects, motionTokenToMs('--cop-duration-slow', 320), readMotionToken('--cop-ease-spring', 'ease-out')),
    );
  },
);

/**
 * 筛选一改的行级过渡：留在屏幕上的行归位滑过去，新出现的行错峰落位
 *
 * 用户是在搜索框里边打字边看的（那一份防抖是 200ms），每一次落定都算一次「重排」。
 * 此前它是硬切：三十条里筛出四条，那四条瞬间从原来的位次跳到新位次，用户分不清
 * 「这几条还在，只是排前面了」和「列表被换成另一批了」——而行级过渡说的正是前者。
 *
 * 三条让路的规矩都写在 `utils/rowMotion.ts`，那边按「输入 → 答案」单测：
 * 同一批行换了顺序（拖拽落位，上面那份 FLIP 已经在放，重复放会把起点算到中间态上）、
 * 上一屏或这一屏空着（表格整块被骨架 / 空态 / 无匹配接替，`panel-swap` 那次交接已经说过话）、
 * 任一侧行数越过 `MAX_ANIMATED_ROWS`（性能账，见常量的注释）。
 *
 * 时机是这块唯一承重的地方，而且它是真机量出来的（`.test-tmp/probe/skeleton-rows-live.cjs`）：
 * `watch` 默认在重渲染**之前**跑，那一刻 `props.rules` 已经是新的、DOM 还是上一版——所以 First
 * 就在这一刻现量，不跨帧存矩形。第一版实现是「每次渲染落地后把位置记下来」，看着更省，
 * 实际会在**表格刚出现的那一次**丢掉整份快照：外层 `panel-swap` 用的是 `mode="out-in"`，
 * 新表格要等旧的退完（90ms）才插进 DOM，那一次的 `nextTick` 里一行都量不到，
 * 于是「表格出现后第一次筛选」永远不动——正是量出来那个红。
 * 现在只剩 `renderedIds` 这一份轻量的「屏幕上现在是哪些行」，配上数量核对（对不上就不动，
 * 宁可少一次动画也不画一次假移动）。换算细节见 `flipFirstRect`。
 */
/** 此刻渲染在屏幕上的那批行 id，与 `visibleRowElements()` 同序（`row-key="id"` 让同一个 id 一直是同一个 `<tr>`） */
let renderedIds: string[] = [];

/** 这一批行是刚出现的（错峰落位的类名），动画放完就摘 */
const settlingIds = ref<Set<string>>(new Set());

/** 摘类名那一拍的定时器：卸载时若还挂着必须掐掉 */
let settleTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.rules.map(rule => rule.id).join('\u0000'),
  async key => {
    const ids = key === '' ? [] : key.split('\u0000');
    const prevIds = renderedIds;
    renderedIds = ids;
    const moved = rowMotionAffordable(prevIds.length, ids.length) && !isSameRowSet(prevIds, ids);
    // 旧位置只能在这一刻量（DOM 还是上一版），而且只在「数量对得上」时才认：
    // 面板交接那一帧 DOM 里一行都没有，或中途已经又变过一次，这份 id 就不代表这批元素
    const beforeNodes = moved ? visibleRowElements() : [];
    const first = new Map<string, RowPosition>();
    if (moved && beforeNodes.length === prevIds.length) {
      prevIds.forEach((id, index) => {
        const el = beforeNodes[index];
        first.set(id, { left: el.offsetLeft, top: el.offsetTop });
      });
    }
    const fresh = moved ? freshRowIds(prevIds, ids) : [];
    // 每一次集合变化都要重新发这份名单，**包括没有新行的那一次**：只在新行出现时写、靠定时器收，
    // 就会在「筛到空 → 表格被无匹配面板接替 → 400ms 内又筛回原来那三条」这一串里把上一批的类名
    // 盖到刚重建的元素上（`panel-swap` 那次交接之上再叠一次行级上浮，然后被那只旧定时器中途掐掉）。
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    settlingIds.value = new Set(fresh);
    if (fresh.length > 0) {
      // 摘早了就是动画中途把行抽回静止态，摘晚了就是上面那一串。时长与错峰阶梯的最高一档都在 CSS 里，
      // 这里按同源的两个值等：base 档时长 + 阶梯顶档延迟。
      settleTimer = setTimeout(
        () => {
          settlingIds.value = new Set();
          settleTimer = null;
        },
        motionTokenToMs('--cop-duration-base', 220) + ROW_STAGGER_MAX_DELAY_MS,
      );
    }
    if (first.size === 0) return;
    await nextTick();
    // 搜索框是边打字边触发的（那份防抖 200ms），两轮之间完全可能插进第三轮。
    // DOM 已经不属于这一次 key 就整包作废——作废一次动画只是少一次动，拿错版的位置放一次 FLIP
    // 是画出一次假移动（与 `useDnrSupport` 那条「过期轮次整包作废」同一条取舍）。
    if (props.rules.map(rule => rule.id).join('\u0000') !== key) return;
    const nodes = visibleRowElements();
    if (nodes.length !== ids.length) return;
    const rects = new Map<HTMLElement, FlipRect>();
    ids.forEach((id, index) => {
      const before = first.get(id);
      const el = nodes[index];
      // 新出现的行归 `row-fresh` 那一下管，两批绝不重叠——重叠就是同一行同时收到两种动画
      if (!before) return;
      const now = { left: el.offsetLeft, top: el.offsetTop };
      if (before.top === now.top && before.left === now.left) return;
      const viewport = el.getBoundingClientRect();
      rects.set(el, flipFirstRect(before, now, { left: viewport.left, top: viewport.top }));
    });
    applyFlip(rects, motionTokenToMs('--cop-duration-slow', 320), readMotionToken('--cop-ease-spring', 'ease-out'));
  },
);

/**
 * 刚保存 / 刚复制的那一行要滚进视野。
 *
 * 新增是 `rules.value.push(...)`——200 条时新行落在表格最底部，多半在视口之外；父组件给的
 * 进场动画此时只发生在「看不见的那一节」上，用户读完成功提示却在表格里找不着那条规则。
 * 判据只用 `block: 'nearest'`：已经看得见就不动（否则每次编辑保存页面都要跳一下），
 * 与日志抽屉的键盘选行同一口径。
 *
 * `behavior` 必须由 JS 侧认 `prefers-reduced-motion`：令牌层那条 `scroll-behavior: auto !important`
 * 收的是 CSS 声明，`scrollIntoView` 的实参优先级更高，不传 `'auto'` 就是减弱档下照样平滑滚。
 *
 * 被筛选挡住的规则（`index === -1`）不滚也不报错——那一条本来就不在这张表里，
 * 自动改筛选条件属于交互变更，不在动效这一轮的授权范围内。
 */
watch(
  () => props.highlightRuleId,
  ruleId => {
    if (!ruleId) return;
    const index = props.rules.findIndex(rule => rule.id === ruleId);
    if (index === -1) return;
    void nextTick(() => {
      visibleRowElements()[index]?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    });
  },
);

/** 删除行的离场时长：与 CSS 那条 transition 同源，减 20ms 让移除落在动画收尾之前，避免尾帧空跳 */
function leaveDurationMs(): number {
  // 减少动效时 CSS 那边已被压成 0.01ms，这里若还等 320ms，那一行就是「先淡没再凭空消失」
  if (prefersReducedMotion()) return 0;
  return Math.max(0, motionTokenToMs('--cop-duration-slow', 320) - 20);
}

/** 删除：先播放右滑出屏动画，再真正移除 */
function handleDelete(rule: ProxyRule) {
  leavingIds.value.add(rule.id);
  const delay = leaveDurationMs();
  if (delay === 0) {
    leavingIds.value.delete(rule.id);
    emit('delete', rule.id);
    return;
  }
  window.setTimeout(() => {
    leavingIds.value.delete(rule.id);
    emit('delete', rule.id);
  }, delay);
}

function rowClassName({ row }: { row: ProxyRule }): string {
  if (leavingIds.value.has(row.id)) return 'row-leaving';
  if (props.highlightRuleId && row.id === props.highlightRuleId) return 'row-entering';
  if (dragOverId.value && row.id === dragOverId.value) return 'row-drag-over';
  // 排在最后：这一行同时是「刚保存的那一条」时，那一下绿边加下落说的是更具体的一件事
  if (settlingIds.value.has(row.id)) return 'row-fresh';
  return '';
}

function matchTypeTagType(matchType: string) {
  return MATCH_TYPE_TAG_TYPES[matchType] || 'info';
}

function matchTypeLabel(matchType: string) {
  const labelMap: Record<string, string> = {
    wildcard: t('matchTypeWildcard'),
    prefix: t('matchTypePrefix'),
    regex: t('matchTypeRegex'),
  };
  return labelMap[matchType] || matchType;
}

/** WebSocket 规则识别：复用 utils/urlMatcher 共享判定（与分流逻辑单一事实来源） */
function isWsRule(rule: ProxyRule): boolean {
  return isWebSocketRule(rule);
}

/**
 * 长连接的能力面只有「重写地址 / 注入查询参数 / 阻断」三项（同一句 `wsRuleHint` 说的就是它）。
 * 头、体、响应改写、Mock、延迟、重试、携带 Cookie 在握手上一律不生效，所以 WS 规则上
 * 不画这几枚徽章——否则同一行里先承诺七次、再由 WS 那一枚把话收回去。
 */
function showsHttpOnlyBadge(rule: ProxyRule): boolean {
  return !isWsRule(rule);
}
</script>

<style scoped>
.rule-table-card {
  padding: 8px;
  margin: 0 32px 32px;
  background: var(--cop-bg-color);
  border-radius: 8px;
  box-shadow: var(--cop-shadow-md);
}

.no-match {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  padding: 48px 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

/* 读取失败那一格：占位高度与 .no-match 同级（同为 48px 上下留白），
   换到表格时卡片不额外跳一次；措辞见 composable 里 `configReadFailed` 的注释。 */
.read-failed {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  padding: 48px 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

.read-failed-text {
  max-width: 420px;
  margin: 0;
  line-height: 1.6;
}

/* 空态 / 读不到 / 无匹配 / 表格四块面板的交接：旧的先退（90ms，只淡出不占时间），
   新的再进（150ms，淡入 + 4px 上浮）。`mode="out-in"` 让两者不重叠——
   重叠会让卡片高度在中间那一帧取两者的最大值，整页跟着往下弹一次。
   时长全部取自令牌，减弱动效下由 tokens.css 那条全局收口压成瞬时切换。 */
.panel-swap-enter-active {
  transition:
    opacity var(--cop-duration-fast) var(--cop-ease-enter),
    transform var(--cop-duration-fast) var(--cop-ease-enter);
}

.panel-swap-leave-active {
  transition: opacity var(--cop-duration-instant) var(--cop-ease-exit);
}

.panel-swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.panel-swap-leave-to {
  opacity: 0;
}

/* 表头底色跟随主题浅面色 */
.rule-table :deep(.el-table__header th) {
  color: var(--cop-text-color-regular);
  background: var(--cop-surface-2);
}

/* 行 hover 上浮 + 主题色阴影 */
.rule-table :deep(.el-table__row) {
  /* 显式列属性而不是 `all`：这一行现在还要被 FLIP 归位动画驱动，`transition: all`
     会把列宽变化、勾选框尺寸这类布局量一并卷进过渡，重排时表现为整行「软一下」 */
  transition:
    background-color var(--cop-duration-fast) var(--cop-ease-standard),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard),
    transform var(--cop-duration-fast) var(--cop-ease-standard);
}

.rule-table :deep(.el-table__row:hover) {
  box-shadow: 0 4px 12px rgb(var(--cop-primary-rgb) / 12%);
  transform: translateY(-2px);
}

/* circle 操作按钮：hover 着主题色，::after 扩大触控热区 */
.row-actions {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.row-actions .el-button {
  position: relative;
  width: 28px;
  height: 28px;
  margin: 0;
}

.row-actions .el-button::after {
  position: absolute;
  inset: -5px;
  content: '';
}

/* 新增行：下落淡入 + 绿色底边（方向与 `cop-rise-in` 相反——新行是从上面掉进队列的），
   底边之外再给两拍主色薄膜：`flashHighlight` 的标记窗口是 1.2s，单拍下落落在 200 行的表格
   底部时，「滚过去的那一眼」很容易错过，两拍是把视线钉在那一行的那一下。
   光晕画在 `td` 的 inset box-shadow 上而不是 `background-color` 上：后者要在 from/to 写一个
   「静止态」的颜色，而单元格的本底属于 Element Plus，抄一份白色就是给自己埋暗色的雷。 */
.rule-table :deep(.row-entering) {
  animation: row-drop-in var(--cop-duration-slow) var(--cop-ease-enter);
}

.rule-table :deep(.row-entering td) {
  border-bottom: 2px solid var(--el-color-success);
  animation: row-flash var(--cop-duration-base) var(--cop-ease-standard) 2;
}

@keyframes row-drop-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 三档必须写成 `0% / 50% / 100%`：Stylelint 的 `keyframe-selector-notation` 按「同一块里
   记法一致」判，掺进一个百分号停点，`from` / `to` 就是要被改写的两个（本文件其余关键帧只有
   首尾两档，写 `from` / `to` 是合规的）。 */
@keyframes row-flash {
  0% {
    box-shadow: inset 0 0 0 60px rgb(var(--cop-primary-rgb) / 0%);
  }

  50% {
    box-shadow: inset 0 0 0 60px rgb(var(--cop-primary-rgb) / 12%);
  }

  100% {
    box-shadow: inset 0 0 0 60px rgb(var(--cop-primary-rgb) / 0%);
  }
}

/* 筛选后新出现的行：错峰落位。留在屏幕上的那批由 JS 的 FLIP 归位，这一批是「刚被筛回来」，
   两种经历不该画成同一种动。
   每一级写成 `n + k`（「第 k 行起」）而不是逐个点名：逐个点名今天完全正确，将来这一屏多出一行
   没有规则命中它，延迟就回落到 0、跟第一行同时进场，阶梯走到末尾倒着跳一次且无任何报错
   （同 `EmptyGuide.vue` 那叠卡的口径）。最高一档刻意停在 180ms 并且后面不再加档：
   `MAX_ANIMATED_ROWS` 允许 60 行，真按逐行 +60ms 排下去，最后一行要等 3.5 秒开外才动。
   填充只写 `backwards`（延迟期间停在起始帧）——写 `both` 会把 `transform` 冻在末帧，
   而动画在级联里排在 `:hover` 之前，那一行的悬浮抬升当场失效。
   这里的 180ms 与 JS 侧摘类名的 `ROW_STAGGER_MAX_DELAY_MS` 必须是同一个数，
   由 `tests/rowMotion.test.ts` 按 CSS 里实际出现的最大值对账。 */
.rule-table :deep(.row-fresh) {
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter) backwards;
}

.rule-table :deep(.row-fresh:nth-child(n + 3)) {
  animation-delay: 60ms;
}

.rule-table :deep(.row-fresh:nth-child(n + 5)) {
  animation-delay: 120ms;
}

.rule-table :deep(.row-fresh:nth-child(n + 7)) {
  animation-delay: 180ms;
}

/* 删除行：右滑出屏淡出。时长与 `leaveDurationMs()` 同源（令牌 slow 档），
   那一边等这个点再真正移除，两边各写一个数就会出现「动画没放完行就没了」 */
.rule-table :deep(.row-leaving) {
  opacity: 0;
  transform: translateX(60px);
  transition:
    opacity var(--cop-duration-slow) var(--cop-ease-exit),
    transform var(--cop-duration-slow) var(--cop-ease-exit);
}

/* 拖拽悬停目标行：主题色提示线。
   画在 inset box-shadow 上而不是 border-top——边框会真的把行撑高 2px，
   拖过几行的过程中下面每一行都跟着抖一次，看起来像拖不动 */
.rule-table :deep(.row-drag-over) {
  background: var(--cop-primary-bg, #ecf5ff);
}

.rule-table :deep(.row-drag-over td) {
  box-shadow: inset 0 2px 0 var(--cop-primary, #409eff);
}

@media (width <= 768px) {
  .rule-table-card {
    margin: 0 20px 20px;
  }
}

:deep(.search-highlight) {
  padding: 0 2px;
  color: var(--cop-primary);
  background: var(--cop-primary-bg);
  border-radius: 2px;
}

/* ─── Drag Handle ─────────────────────────────────────────────────────────── */

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 16px;
  color: var(--cop-text-color-placeholder, #c0c4cc);
  cursor: grab;
  user-select: none;
  border-radius: 4px;
  transition:
    color var(--cop-duration-instant) var(--cop-ease-standard),
    background-color var(--cop-duration-instant) var(--cop-ease-standard);
}

.drag-handle:hover {
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-header-icon {
  font-size: 14px;
  color: var(--cop-text-color-placeholder, #c0c4cc);
  cursor: help;
}

/* ─── Rule Name Cell with Badges ──────────────────────────────────────────── */

.rule-name-cell {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

/* 标签 chip：尺寸与能力徽章对齐（11px 字 + 18px 盒子），但走次要字色——它是分类物，
   不该抢「这条规则会干什么」的注意力。字号不往 10px 走：这一格是用户自己写的中文词，
   「结算」在这种笔画密度下 10px 就粘成一团，而本仓那条地线正是为它立的（评审 L-15）。 */
.rule-tags {
  display: inline-flex;
  flex-shrink: 0;
  gap: 3px;
  align-items: center;
  max-width: 148px;
  overflow: hidden;
}

.rule-tag {
  padding: 0 5px;
  font-size: 11px;
  line-height: 16px;
  color: var(--cop-text-color-secondary);
  white-space: nowrap;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color);
  border-radius: 8px;
}

.rule-tag--more {
  font-variant-numeric: tabular-nums;
}

.rule-badges {
  display: inline-flex;
  flex-shrink: 0;
  gap: 3px;
}

/* 徽章里的字母按本仓库那条「可见文字不低于 11px」的地线走（评审 L-15，其余 18 处小字都是 11px）。
   宽度用 `min-width` 而不是 `width`：单字母时算出来的盒子与原来一模一样（11px 700 字重的
   大写「H」约 8px，小于 18px 的下限），但哪一天某个字母在回退字体里宽过盒子，它会长大而不是
   把字挤出去——固定宽度配居中的 flex，溢出是两像素一边地压到邻格上，看不出来也修不回来。 */
.rule-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  border-radius: 4px;
}

.rule-badge--h {
  color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
}

/* 凭据开关是「这条规则会带走你的会话」的提醒，用中性 info 色，不与 X（阻断）抢红 */
.rule-badge--c {
  color: var(--el-color-info, #909399);
  background: var(--el-color-info-light-9, #f4f4f5);
}

.rule-badge--b {
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, #fdf6ec);
}

.rule-badge--r {
  color: var(--el-color-success, #67c23a);
  background: var(--el-color-success-light-9, #f0f9eb);
}

.rule-badge--m {
  color: var(--cop-badge-violet);
  background: var(--cop-badge-violet-bg);
}

.rule-badge--d {
  color: var(--cop-badge-cyan);
  background: var(--cop-badge-cyan-bg);
}

.rule-badge--x {
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef2f2);
}

.rule-badge--re {
  color: var(--cop-badge-amber);
  background: var(--cop-badge-amber-bg);
}

/* 与 M 同色系：两者如今不会同屏出现（WS 规则不再画 M 那七枚），字母也各不一样。
   两个字母按 11px 排出来约 17px，所以这一枚的下限比单字母那几枚宽 2px（17 + 2 × 1.5px 留白），
   仍然是 `min-width`：中文字体回退下真变宽了，它自己长大。 */
.rule-badge--ws {
  min-width: 20px;
  color: var(--cop-badge-violet);
  background: var(--cop-badge-violet-bg);
}

.hit-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
  border-radius: 10px;
}

/* 两条通道各一枚：网络层（DNR）用主色，扩展通道（SW）用 warning，与抽屉里的 DNR/SW 标签同色系 */
.hit-stats-pair {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.hit-count-badge--ext {
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, #fdf6ec);
}

/* 「不知道」不是「零次」：读不到网络层计数时画灰化的破折号 */
.hit-count-unknown {
  color: var(--el-text-color-placeholder, #c0c4cc);
  background: var(--el-fill-color-light, #f5f7fa);
}

/* 数字自己换过一次才动：`:key` 绑在读数上，值没变就不会重挂载，所以这一下只在「数真的变了」
   那一拍响（采样是周期性的，读数不变时表格安静）。方向只向上滚 3px、配 40% 的淡入，
   是为了让「这一格刚变过」被看见，而不是让一个 24px 的小胶囊跳舞。
   刻意不给「读不到」那一格加呼吸循环——它会画成「正在读」，而这一格存在的全部理由正是
   「没有读数」与「零次」必须分开。 */
.hit-count-digit {
  display: inline-block;
  animation: hit-roll-in var(--cop-duration-base) var(--cop-ease-enter);
}

@keyframes hit-roll-in {
  from {
    opacity: 0.4;
    transform: translateY(3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.hit-count-zero {
  font-size: 12px;
  color: var(--el-text-color-placeholder, #c0c4cc);
}

/* 「!」这颗按 11px 排（L-15 那条地线）：16px 圆里放一个约 4px 宽的感叹号，字号抬一档不会顶到边。
   它的 `color: #fff` 是 designTokens 守卫里点名记着的那处例外（琥珀底配白字约 2.1:1），
   本轮只动字号，不动颜色。 */
.shadowed-indicator {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  cursor: help;
  background: var(--el-color-warning, #e6a23c);
  border-radius: 50%;
}

/* 「浏览器不会应用该规则」标记：比遮蔽标记更重，用危险色 + 文字而非仅用颜色表达。
   首次出现时向外扩散一圈再散掉——这条红标今天完全静态，而 200 行的表格里「滚过去也注意不到」
   正是它最坏的失效方式；`to` 落回「没有 box-shadow」这个静止态，所以动画结束后不必收回。
   关键帧的形状与 popup 那枚状态点的 `dot-ping` 是同一种语言，只换颜色通道。 */
.dnr-dead-tag {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: var(--el-color-danger, #f56c6c);
  cursor: help;
  background: var(--el-color-danger-light-9, #fef2f2);
  border: 1px solid var(--el-color-danger-light-7, #f5cccc);
  border-radius: 4px;
  animation: dead-tag-halo var(--cop-duration-slow) var(--cop-ease-standard) 1;
}

@keyframes dead-tag-halo {
  from {
    box-shadow: 0 0 0 0 rgb(var(--cop-danger-rgb) / 55%);
  }

  to {
    box-shadow: 0 0 0 6px rgb(var(--cop-danger-rgb) / 0%);
  }
}

.dnr-skip-tip p {
  margin: 0;
  line-height: 1.6;
}

.dnr-skip-tip p + p {
  margin-top: 4px;
}
</style>
