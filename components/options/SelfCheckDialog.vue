<template>
  <el-dialog
    :model-value="visible"
    :title="t('selfCheckTitle')"
    width="600px"
    align-center
    @close="$emit('update:visible', false)"
  >
    <div class="self-check-dialog">
      <div class="self-check-head">
        <span
          class="self-check-page"
          :title="readout.probeUrl || undefined"
          >{{ pageLabel }}</span
        >
        <el-button
          size="small"
          plain
          :icon="Refresh"
          :loading="readout.reading"
          @click="run"
        >
          {{ t('selfCheckRerun') }}
        </el-button>
      </div>

      <!-- 没有对应的网页标签页时先说这一句：下面那几行里有三行本来就只能画「不知道」，
           不说清原因，那一排「不知道」读起来像这一屏坏了 -->
      <p
        v-if="tabId === null"
        class="self-check-note"
      >
        {{ t('selfCheckNoTab') }}
      </p>

      <!-- 首屏那一次读数还在路上：这里不许出现「什么都没有」，也不许出现上一次那一屏的五行
           （与本仓规则表「骨架 → 读失败 → 空态」同一条次序，只是这里没有失败与空态那两档） -->
      <p
        v-if="readout.reading && !everSettled"
        class="self-check-loading"
        role="status"
      >
        {{ t('selfCheckRowsReading') }}
      </p>

      <ul
        v-else
        class="self-check-rows"
      >
        <li
          v-for="row in rows"
          :key="row.key"
          class="self-check-row"
        >
          <el-tag
            size="small"
            :type="levelTagType(row.level)"
            class="self-check-tag"
          >
            {{ levelWord(row.level) }}
          </el-tag>
          <span class="self-check-text">{{ rowText(row) }}</span>
        </li>
      </ul>

      <!-- 重跑在途时手里这五行是**上一次**那一轮的结果：表格长得和平时一模一样，不说就是让人当现状 -->
      <p
        v-if="readout.reading && everSettled"
        class="self-check-note"
        role="status"
      >
        {{ t('selfCheckRowsRefreshing') }}
      </p>

      <p class="self-check-foot">{{ t('selfCheckFootnote') }}</p>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import type { SelfCheckLevel, SelfCheckRow } from '@/utils/selfCheck';
import { buildSelfCheckRows } from '@/utils/selfCheck';
import { useSelfCheck } from '@/composables/useSelfCheck';
import { useI18n } from '@/composables/useI18n';

/**
 * 连通性自检面板
 *
 * 一屏回答「这一页为什么没走代理」：开关 → 这一台站点 → 配置送达 → 这条地址命中谁 → 网络层装了几条。
 * 装配层只做三件事——发那几笔读数、把判定并进来、按行挑那一句字面量文案。**这里不许长出第四条判据**：
 * 每一行的结论都来自一个已经存在的出口（`utils/selfCheck.ts` 逐一说明），第二份「代理会怎么做」的模型
 * 就是下一次两句话互相打脸的开始，也是 `utils/diagnosis.ts` 当初写下「不做那三档」的同一个理由。
 */
const props = defineProps<{
  visible: boolean;
  /** 被检查那一页的标签页 id；`null` = 这一屏没有对应网页（从配置页里直接打开时就是这种） */
  tabId: number | null;
  /** 「浏览器不会应用」那份判定（规则列表与 URL 预演共用同一份，这里只消费，不再跑第二遍 RE2） */
  dnrSkippedRules: Map<string, DnrSkipReason>;
  /** 上面那份判定**落到过一次**没有：空 Map 不等于「都会应用」 */
  dnrSupportRead: boolean;
}>();

defineEmits<{
  'update:visible': [value: boolean];
}>();

const { t } = useI18n();
const { readout, refresh } = useSelfCheck();

/** 组件自己的那一份「读到过一次」：判定与读数分家，模板只读这一份 */
const rows = ref<SelfCheckRow[]>([]);
/** 屏幕上这五行属于**哪一个标签页**的那次阅读；换页时先摘掉，免得把上一台的结论挂在这一台下面 */
const rowsOwner = ref<number | null>(null);
/** 这一屏有没有落定过一次：没有的话首帧画五行占位，而不是画一个「什么都没查出来」的空列表 */
const everSettled = ref(false);

/** 组件这一侧的轮次令牌：composable 里那一份管读数归谁，这一份管「这五行该记在哪一页名下」 */
let runSeq = 0;

async function run(): Promise<void> {
  const seq = ++runSeq;
  const target = props.tabId;
  // 换到另一页（或从「没有网页」换到某一页）时，手里那五行说的是**别的那一页**——
  // 与本仓「以下是上一次读到的记录」同一族：要么说清它是旧的，要么先摘掉。
  // 这里选摘掉，因为这一屏的五行彼此是连着的（同一轮的五笔读数），留一半换一半反而更像同一份答案。
  if (rowsOwner.value !== target) rows.value = [];
  await refresh(target);
  // 更晚那一次已经在跑（换页，或那份 RE2 判定刚好落了）：这一轮的账不记，免得把两轮的答案混成一屏
  if (seq !== runSeq) return;
  rows.value = buildSelfCheckRows(
    {
      status: readout.value.status,
      siteState: readout.value.siteState,
      configSynced: readout.value.configSynced,
      install: readout.value.install,
      rules: readout.value.rules,
      probeUrl: readout.value.probeUrl,
      host: readout.value.host,
    },
    // 那份 RE2 判定没落到过时交 `null`：交一个空 Set 等于替浏览器说一句「这些规则它都会应用」
    props.dnrSupportRead ? new Set(props.dnrSkippedRules.keys()) : null,
  );
  rowsOwner.value = target;
  everSettled.value = true;
}

// 打开、换页都重读一次；skip 判定落地后也要重算那一行，否则它会永远停在「不知道」
watch(
  () => [props.visible, props.tabId, props.dnrSupportRead, props.dnrSkippedRules] as const,
  ([visible]) => {
    if (visible) void run();
  },
  { immediate: true },
);

const pageLabel = computed(() => {
  if (readout.value.host) return readout.value.host;
  if (readout.value.reading) return t('selfCheckPageReading');
  return t('selfCheckPageUnknown');
});

/**
 * 一行一句话，每个分支都是字面量 key
 *
 * 刻意不用拼出来的动态键：`tests/i18n.test.ts` 只扫字面量调用，拼出来的那个 key 打错了不红，
 * 而表现是把那行诊断画成裸键名——一屏排障工具顶着一串 `selfCheckSiteundefined`。
 */
function rowText(row: SelfCheckRow): string {
  const [first = '', second = ''] = row.params ?? [];
  switch (`${row.key}.${row.level}`) {
    case 'switch.ok':
      return t('selfCheckSwitchOk', [first]);
    case 'switch.fail':
      return t('selfCheckSwitchOff');
    case 'switch.unknown':
      return t('selfCheckSwitchUnknown');
    case 'site.ok':
      return t('selfCheckSiteOk', [modeWord(first)]);
    case 'site.fail':
      return t('selfCheckSiteBlocked', [modeWord(first)]);
    case 'site.unknown':
      return t('selfCheckSiteUnknown');
    case 'delivery.ok':
      return t('selfCheckDeliveryOk');
    case 'delivery.warn':
      return t('selfCheckDeliveryStale');
    case 'delivery.unknown':
      return t('selfCheckDeliveryUnknown');
    case 'match.ok':
      return t('selfCheckMatchOk', [first, viaWord(second)]);
    case 'match.pending':
      return t('selfCheckMatchPending', [first, viaWord(second)]);
    case 'match.warn':
      return t('selfCheckMatchNone');
    case 'match.fail':
      return t('selfCheckMatchSkipped', [first]);
    case 'match.unknown':
      return t('selfCheckMatchUnknown');
    case 'install.ok':
      return t('selfCheckInstallOk', [first]);
    case 'install.pending':
      return t('selfCheckInstallPending', [first, second]);
    case 'install.fail':
      return t('selfCheckInstallMismatch', [first, second]);
    case 'install.unknown':
      return t('selfCheckInstallUnknown');
    default:
      return t('selfCheckUnknown');
  }
}

function viaWord(via: string): string {
  return via === 'network' ? t('selfCheckViaNetwork') : t('selfCheckViaForward');
}

/** 站点名单那一格要说的是**哪一种**名单模式：「不在名单里」与「这台被排除了」是两件相反的事 */
function modeWord(mode: string): string {
  if (mode === 'site-only') return t('selfCheckModeAllowList');
  if (mode === 'site-off') return t('selfCheckModeExcludeList');
  return t('selfCheckModeAll');
}

function levelWord(level: SelfCheckLevel): string {
  switch (level) {
    case 'ok':
      return t('selfCheckLevelOk');
    case 'warn':
      return t('selfCheckLevelWarn');
    case 'fail':
      return t('selfCheckLevelFail');
    case 'pending':
      return t('selfCheckLevelPending');
    default:
      return t('selfCheckLevelUnknown');
  }
}

/**
 * 颜色只表达档位，不表达类别；`unknown` 与 `pending` 都走 `info` 而不是 `success`——
 * 「没读到」与「还没落定」画成「正常」，就是让这一屏最没信息量的那一格看起来最安心。
 * 两者共用一个色相是刻意的：它们说的是同一件事（这一格不作结论），区别在字面上。
 * `ElTagProps['type']` 的联合里没有「中性」那一档，空串是既有约定（规则列表与弹窗同一条路）。
 */
function levelTagType(level: SelfCheckLevel): 'success' | 'warning' | 'danger' | 'info' {
  if (level === 'ok') return 'success';
  if (level === 'warn') return 'warning';
  if (level === 'fail') return 'danger';
  return 'info';
}
</script>

<style scoped>
.self-check-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.self-check-head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}

.self-check-page {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: var(--cop-text-color-primary, #303133);
  white-space: nowrap;
}

.self-check-note,
.self-check-foot {
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-secondary, #909399);
}

.self-check-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.self-check-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.self-check-tag {
  flex-shrink: 0;
}

.self-check-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--cop-text-color-regular, #606266);
}
</style>
