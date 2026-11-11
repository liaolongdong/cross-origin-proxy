<template>
  <el-dialog
    :model-value="visible"
    :title="t('envDiffTitle')"
    width="860px"
    align-center
    @close="handleDialogClose"
  >
    <div class="env-diff dialog-body-scroll">
      <div class="env-diff-field">
        <label
          class="env-diff-label"
          for="env-diff-a"
          >{{ t('envDiffLabelA') }}</label
        >
        <el-input
          id="env-diff-a"
          v-model="urlA"
          :placeholder="t('envDiffUrlPlaceholder')"
          clearable
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="env-diff-field">
        <label
          class="env-diff-label"
          for="env-diff-b"
          >{{ t('envDiffLabelB') }}</label
        >
        <el-input
          id="env-diff-b"
          v-model="urlB"
          :placeholder="t('envDiffUrlPlaceholder')"
          clearable
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="env-diff-inline">
        <label
          class="env-diff-label"
          for="env-diff-method"
          >{{ t('envDiffMethodLabel') }}</label
        >
        <el-select
          id="env-diff-method"
          v-model="method"
          class="env-diff-method"
        >
          <el-option
            v-for="item in HTTP_METHODS"
            :key="item"
            :label="item"
            :value="item"
          />
        </el-select>
        <el-checkbox
          v-model="sendCredentials"
          class="env-diff-cookies"
          :label="t('envDiffSendCookies')"
        />
      </div>

      <div class="env-diff-headers">
        <div class="env-diff-headers-head">
          <span class="env-diff-label">{{ t('envDiffHeadersLabel') }}</span>
          <el-button
            type="primary"
            link
            :icon="Plus"
            @click="addHeaderRow"
          >
            {{ t('addHeader') }}
          </el-button>
        </div>
        <div
          v-for="(row, index) in headerRows"
          :key="row.uid"
          class="env-diff-header-row"
        >
          <el-input
            :id="`env-diff-header-key-${row.uid}`"
            v-model="row.key"
            :placeholder="t('headerNamePlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
          <el-input
            v-model="row.value"
            :placeholder="t('headerValuePlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
          <el-button
            type="danger"
            link
            :icon="Delete"
            :aria-label="t('removeHeaderA11y', index + 1)"
            @click="headerRows.splice(index, 1)"
          />
        </div>
      </div>

      <div class="env-diff-field">
        <label
          class="env-diff-label"
          for="env-diff-body"
          >{{ t('envDiffBodyLabel') }}</label
        >
        <el-input
          id="env-diff-body"
          v-model="bodyText"
          type="textarea"
          :rows="4"
          :disabled="methodCarriesNoBody"
          :placeholder="methodCarriesNoBody ? t('envDiffBodyDisabledHint') : t('envDiffBodyPlaceholder')"
          spellcheck="false"
        />
        <p class="env-diff-hint">
          {{ t('envDiffVarHint') }}
        </p>
      </div>

      <div class="env-diff-pick">
        <button
          type="button"
          class="env-diff-pick-toggle"
          :aria-expanded="pickOpen ? 'true' : 'false'"
          @click="togglePick"
        >
          {{ t('envDiffPickToggle') }}
        </button>
        <div
          v-show="pickOpen"
          class="env-diff-pick-body"
        >
          <p
            v-if="pickLoading && !pickEverRead"
            class="env-diff-pick-state"
            role="status"
          >
            {{ t('envDiffPickLoading') }}
          </p>
          <template v-else-if="pickReadFailed">
            <p
              class="env-diff-pick-state"
              role="status"
            >
              {{ t('envDiffPickReadFailed') }}
            </p>
            <el-button
              size="small"
              @click="loadPicks"
              >{{ t('refresh') }}</el-button
            >
          </template>
          <p
            v-else-if="pickRows.length === 0"
            class="env-diff-pick-state"
          >
            {{ t('envDiffPickEmpty') }}
          </p>
          <ul
            v-else
            class="env-diff-pick-list"
          >
            <li
              v-for="row in pickRows"
              :key="row.id"
              class="env-diff-pick-item"
            >
              <button
                type="button"
                class="env-diff-pick-btn"
                :disabled="!row.prefill.ok"
                :title="rowBlockedReason(row) || row.url"
                @click="applyPick(row)"
              >
                {{ pickRowLabel(row) }}
              </button>
              <span
                v-if="row.blocked"
                class="env-diff-pick-blocked"
                >{{ rowBlockedReason(row) }}</span
              >
            </li>
          </ul>
          <p class="env-diff-pick-note">{{ t('envDiffPickNote') }}</p>
        </div>
      </div>

      <p class="env-diff-boundary">
        {{ t('envDiffBoundary') }}
      </p>

      <template v-if="pair">
        <p
          class="env-diff-verdict"
          role="status"
        >
          {{ verdictSentence }}
        </p>
        <div class="env-diff-cols">
          <div
            v-for="side in ['a', 'b'] as const"
            :key="side"
            class="env-diff-col"
          >
            <div class="env-diff-meta">
              <el-tag
                :type="sideTagType(side)"
                size="small"
                effect="plain"
              >
                {{ sideStatusText(side) }}
              </el-tag>
              <span class="env-diff-meta-note">{{ sideMetaNote(side) }}</span>
            </div>
            <div class="env-diff-body">
              <template v-if="sideError(side)">
                <p class="env-diff-error">{{ sideError(side) }}</p>
              </template>
              <template v-else-if="sideLines(side).length > 0">
                <p
                  v-for="(line, index) in sideLines(side)"
                  :key="index"
                  class="env-diff-line"
                  :class="{ 'is-diff': diffLineFlags(side)[index] }"
                >
                  <span
                    class="env-diff-line-no"
                    aria-hidden="true"
                    >{{ index + 1 }}</span
                  ><span
                    v-if="diffLineFlags(side)[index]"
                    class="env-diff-line-mark"
                    aria-hidden="true"
                    >≠</span
                  ><span class="env-diff-line-text">{{ line }}</span
                  ><span
                    v-if="diffLineFlags(side)[index]"
                    class="env-diff-visually-hidden"
                    >{{ t('envDiffLineDiff') }}</span
                  >
                </p>
              </template>
              <p
                v-else
                class="env-diff-no-body"
              >
                {{ t('envDiffNoBody') }}
              </p>
            </div>
          </div>
        </div>
      </template>
      <p
        v-else-if="roundCancelled"
        class="env-diff-hint"
        role="status"
      >
        {{ t('envDiffCancelledRound') }}
      </p>
    </div>

    <template #footer>
      <el-button
        v-if="running"
        @click="stopPair"
      >
        {{ t('cancel') }}
      </el-button>
      <el-button
        type="primary"
        :loading="running"
        :disabled="!canRun"
        @click="runComparison"
      >
        {{ t('envDiffRun') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Delete, Plus } from '@element-plus/icons-vue';
import type { TagProps } from 'element-plus';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from '@/composables/useI18n';
import { useEnvDiff, type EnvDiffSideInput } from '@/composables/useEnvDiff';
import { useEnvDiffPick } from '@/composables/useEnvDiffPick';
import type { EnvDiffPickRow } from '@/utils/envDiffPrefill';
import type { EnvDiffResultPayload } from '@/utils/types';
import { HTTP_METHODS } from '@/utils/types';
import { formatClock, getStatusColor } from '@/utils/formatters';
import { needsReplayConfirm } from '@/utils/requestReplay';
import { findFirstBodyDiffLine, prettifyEnvDiffBody } from '@/utils/envDiff';

/**
 * 环境响应对比弹窗（`#env-diff`）
 *
 * 同一输入原样发给两个环境，并排读回状态与正文。它刻意**不经过规则匹配**：用户问的是
 * 「这两个环境自己怎么回」，命中与重写会把两边搬进同一个环境，恰是这一步要排除的情形
 * （与「URL 匹配预演」是前后两步，不是重复功能）。发送判据复用代发那一条路现成的三件事：
 * 协议白名单、头名/CRLF、回包体积（见 `entrypoints/background/envDiff.ts`）。
 * 非安全方法先问一句——判据与日志重放同一份（`needsReplayConfirm`）：第二次下单才是这类
 * 工具最贵的错；代价只是一次点击。
 */
const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
}>();

const { t } = useI18n();
const { running, runPair, cancel } = useEnvDiff();

const urlA = ref('');
const urlB = ref('');
const method = ref<string>('GET');
const sendCredentials = ref(false);
const bodyText = ref('');

interface HeaderRow {
  uid: number;
  key: string;
  value: string;
}
let headerSeed = 0;
const headerRows = ref<HeaderRow[]>([]);

function addHeaderRow() {
  headerRows.value.push({ uid: ++headerSeed, key: '', value: '' });
  // 新行落下那一拍之后，焦点跟着进它的第一格：表单是编辑场所，落点本身就是动作的一部分。
  // 走 id 而不是查询最后一个 `.el-input`——最后一格此刻可能还在过渡里，而 id 是唯一寻址。
  const uid = headerSeed;
  void nextTick(() => {
    document.getElementById(`env-diff-header-key-${uid}`)?.focus();
  });
}

const methodCarriesNoBody = computed(() => {
  const m = method.value.toUpperCase();
  return m === 'GET' || m === 'HEAD';
});

const canRun = computed(() => urlA.value.trim() !== '' && urlB.value.trim() !== '' && !running.value);

type SideKey = 'a' | 'b';
interface PairReadings {
  a: EnvDiffResultPayload;
  b: EnvDiffResultPayload;
}
const pair = ref<PairReadings | null>(null);
/** 取消的那一轮：手里没有新读数时也要说得出「这一轮没下文了」，而不是沉默回表单 */
const roundCancelled = ref(false);

/**
 * 「从最近请求挑一笔」：存在的理由只有一句——这一屏最费手的不是读回包，是抄那四项输入。
 *
 * 三条刻意的边界：
 * ① 只在第一次展开时才去读日志（低频入口不该每次打开弹窗都读一遍 500 条）；
 * ② 预填只动 A 侧与方法 / 头 / 正文，**B 侧留给用户填**——那一个「另一个环境」是这条功能
 *    唯一的问题本身，扩展不猜；
 * ③ 不走地址栏深链：日志里的请求头是原值，进 hash 就是进浏览器历史。
 */
const {
  rows: pickRows,
  loading: pickLoading,
  readFailed: pickReadFailed,
  everRead: pickEverRead,
  load: loadPicks,
} = useEnvDiffPick();
const pickOpen = ref(false);

function togglePick() {
  pickOpen.value = !pickOpen.value;
  if (pickOpen.value && !pickEverRead.value && !pickLoading.value) void loadPicks();
}

/**
 * 四种拒绝各说一句不同的话：它们的修法相反，合成一句「不能用」等于把用户推回猜。
 *
 * 分支一律写字面量 key——拼出来的键 `tests/i18n.test.ts` 扫不到，打错一个字母就是屏幕上
 * 一串裸键名，而那一格恰恰只在数据出问题时才出现，没人会去核对它。
 */
function rowBlockedReason(row: EnvDiffPickRow): string {
  switch (row.blocked) {
    case 'truncated':
      return t('envDiffPickTruncated');
    case 'unsupportedProtocol':
      return t('envDiffPickBadProtocol');
    case 'noMethod':
      return t('envDiffPickBadMethod');
    case 'badUrl':
      return t('envDiffPickBadShape');
    default:
      return '';
  }
}

/** 行上的读数：方法 + 地址 + 时刻。地址是原始那一条（草稿取的就是它），不是重写后的 */
function pickRowLabel(row: EnvDiffPickRow): string {
  const time = row.timestamp ? formatClock(row.timestamp) : '';
  return [row.method || '—', row.url || '—', time].filter(Boolean).join(' · ');
}

function applyPick(row: EnvDiffPickRow) {
  if (!row.prefill.ok) return;
  // 在途那一轮的读数描述的是**发出那一刻**的四项输入。此刻整批改掉，回话落下来就与屏幕上的表单
  // 各说各话——一句「先等它回话」比那个错便宜得多，也比默默取消用户那一轮诚实（取消有它自己的入口）。
  if (running.value) {
    ElMessage.warning(t('envDiffPickBusy'));
    return;
  }
  const { url, method: pickedMethod, headers, body } = row.prefill.draft;
  urlA.value = url;
  method.value = pickedMethod;
  headerRows.value = headers.map(item => ({ uid: ++headerSeed, ...item }));
  bodyText.value = body;
  // 手里那一屏读数说的是上一次的两格，换了输入就不该继续挂在屏幕上
  pair.value = null;
  roundCancelled.value = false;
  ElMessage.success(t('envDiffPickApplied', [pickedMethod]));
}

function sideInput(url: string): EnvDiffSideInput {
  const headers: Record<string, string> = {};
  for (const row of headerRows.value) {
    const key = row.key.trim();
    if (key) headers[key] = row.value;
  }
  const body = methodCarriesNoBody.value ? undefined : bodyText.value || undefined;
  return { url: url.trim(), method: method.value, headers, body, sendCredentials: sendCredentials.value };
}

async function runComparison() {
  if (!canRun.value) return;
  // 与重放同一判据：GET/HEAD/OPTIONS 直发，其余（含认不准的自定义动词）先问一句
  if (needsReplayConfirm(method.value)) {
    try {
      await ElMessageBox.confirm(
        t('envDiffConfirmBody', [method.value.toUpperCase(), urlA.value.trim(), urlB.value.trim()]),
        t('envDiffConfirmTitle'),
        { type: 'warning', confirmButtonText: t('envDiffRun'), cancelButtonText: t('cancel') },
      );
    } catch {
      return;
    }
  }
  roundCancelled.value = false;
  pair.value = null;
  const result = await runPair(sideInput(urlA.value), sideInput(urlB.value));
  if (result) pair.value = result;
}

function stopPair() {
  cancel();
  roundCancelled.value = true;
}

function handleDialogClose() {
  if (running.value) stopPair();
  // 与兄弟弹窗同一条收口：EP 的 X／遮罩只发 `close`，`update:visible` 必须在这里回传，
  // 否则 App 侧的旗标永留 true——第二次点顶栏／⌘K／深链都不再触发 watcher，弹窗永远打不开，
  // 而 `anyOverlayOpen` 卡真会把 ⌘K / N / / 一起拖哑
  emit('update:visible', false);
}

function prettyBody(side: SideKey): string | null {
  const reading = pair.value?.[side];
  if (!reading?.ok || reading.body === null) return null;
  return prettifyEnvDiffBody(reading.body);
}

const prettyA = computed(() => (pair.value ? prettyBody('a') : null));
const prettyB = computed(() => (pair.value ? prettyBody('b') : null));

/** 逐行读数：格式化后的正文按行切开；读不出正文（失败或越界）时是空数组 */
function linesFor(side: SideKey): string[] {
  const text = side === 'a' ? prettyA.value : prettyB.value;
  return text === null ? [] : text.split('\n');
}

const aLines = computed(() => linesFor('a'));
const bLines = computed(() => linesFor('b'));

/** 行号级的「这一行两份不一样」：公共下标逐行比，多出来的行各自标到各自那一侧 */
const diffFlagsA = computed(() =>
  aLines.value.map((line, index) => pair.value !== null && prettyA.value !== null && line !== bLines.value[index]),
);
const diffFlagsB = computed(() =>
  bLines.value.map((line, index) => pair.value !== null && prettyB.value !== null && line !== aLines.value[index]),
);

function diffLineFlags(side: SideKey): boolean[] {
  return side === 'a' ? diffFlagsA.value : diffFlagsB.value;
}

function sideLines(side: SideKey): string[] {
  return side === 'a' ? aLines.value : bLines.value;
}

/** 一句话结论：状态码与正文各判各的，「响应头与耗时不在这个结论里」由边界那句事先说清 */
const verdictSentence = computed(() => {
  const p = pair.value;
  if (!p) return '';
  if (!p.a.ok || !p.b.ok) return t('envDiffVerdictIncomplete');
  if (p.a.status !== p.b.status) return t('envDiffVerdictStatusDiff', [p.a.status, p.b.status]);
  if (p.a.truncated || p.b.truncated) return t('envDiffVerdictTruncated');
  // 「一边空正文、一边有正文」也是真差异（空串按 0 行参与比较，第一行就分家），
  // 不许翻成「没读到」——那一侧明明读到了，只是回了个空
  const firstDiff = findFirstBodyDiffLine(prettyA.value ?? '', prettyB.value ?? '');
  return firstDiff === null ? t('envDiffVerdictIdentical') : t('envDiffVerdictFirstDiff', [firstDiff]);
});

function sideError(side: SideKey): string {
  const reading = pair.value?.[side];
  if (!reading || reading.ok) return '';
  // `bodyTooLarge` 不在这里：那一侧回的是 `ok:true` + `truncated`，正文读不读得回来与
  // 「这一笔有没有发生」是两件事，前者交给 meta 行那句话去说
  const keyByCode: Record<string, string> = {
    url: 'envDiffErrUrl',
    method: 'envDiffErrMethod',
    headers: 'envDiffErrHeaders',
    body: 'envDiffErrBody',
    timeout: 'envDiffErrTimeout',
    cancelled: 'envDiffErrCancelled',
    network: 'envDiffErrNetwork',
    noAnswer: 'envDiffErrNoAnswer',
  };
  const key = reading.error ? keyByCode[reading.error] : undefined;
  return key ? t(key) : t('envDiffErrNetwork');
}

function sideTagType(side: SideKey): TagProps['type'] {
  const reading = pair.value?.[side];
  if (!reading || !reading.ok) return 'danger';
  return getStatusColor(reading.status) as TagProps['type'];
}

function sideStatusText(side: SideKey): string {
  const reading = pair.value?.[side];
  if (!reading) return '';
  if (!reading.ok) return t('envDiffTagFailed');
  return `${reading.status}${reading.statusText ? ` ${reading.statusText}` : ''}`;
}

function sideMetaNote(side: SideKey): string {
  const reading = pair.value?.[side];
  if (!reading) return '';
  const parts = [`${reading.durationMs} ms`];
  if (reading.truncated) parts.push(t('envDiffTruncatedBody'));
  const contentType = reading.headers['content-type'];
  if (contentType) parts.push(contentType);
  return parts.join(' · ');
}

// 打开时把焦点放到地址 A：这一屏的第一件事永远是先交出那两个地址。
// hash 直达时分片带着 visible === true 挂载，`@open` 在那条路径上不保证触发——所以本弹窗
// 不靠 `@open`，聚焦挂在带 immediate 的 visible watcher 上（与四个带初始化 watcher 的弹窗
// 同一条竞态纪律）。
// 后来这里多了第二件事：折叠区上一次是展开的，那就在每次打开时重读一遍最近请求——
// 不重读的话，第二次打开弹窗看到的还是上一屏那几条，而它长得和新鲜读数一模一样。
// `immediate` 那一拍 `pickOpen` 还是 `false`，所以挂载即见的那条路径不会多发一次消息。
watch(
  () => props.visible,
  visible => {
    if (!visible) return;
    if (pickOpen.value) void loadPicks();
    void nextTick(() => {
      document.getElementById('env-diff-a')?.focus();
    });
  },
  { immediate: true },
);
</script>

<style scoped>
.env-diff {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: min(68vh, 640px);
  overflow-y: auto;
}

.env-diff-field {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.env-diff-label {
  flex-shrink: 0;
  width: 64px;
  padding-top: 6px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.env-diff-inline {
  display: flex;
  gap: 14px;
  align-items: center;
}

.env-diff-inline .env-diff-label {
  padding-top: 0;
}

.env-diff-method {
  width: 120px;
}

.env-diff-headers {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.env-diff-headers-head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.env-diff-header-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-left: 74px;

  /* 只有新建的那一行会重挂（key 是 `row.uid`），所以这一拍天然只给新行——
     不需要额外的类名，也就不需要第二份「哪一行是新的」的判据 */
  animation: cop-rise-in var(--cop-duration-fast) var(--cop-ease-enter) backwards;
}

.env-diff-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

/* 「从最近请求挑一笔」：捷径不是这一屏的主角，所以默认收起、文字入口、不加边框卡片重量。
   被拒的那条仍出现在列表里，只是按钮不画——看不见的那条拒绝等于没说过。 */
.env-diff-pick {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.env-diff-pick-toggle {
  align-self: flex-start;
  padding: 0;
  font-size: 13px;
  color: var(--cop-primary);
  cursor: pointer;
  background: none;
  border: none;
}

.env-diff-pick-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.env-diff-pick-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.env-diff-pick-item {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.env-diff-pick-btn {
  max-width: 100%;
  padding: 4px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-primary);
  white-space: nowrap;
  cursor: pointer;
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 6px;
}

.env-diff-pick-btn:disabled {
  color: var(--cop-text-color-secondary);
  cursor: not-allowed;
}

.env-diff-pick-btn:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 1px;
}

.env-diff-pick-blocked,
.env-diff-pick-state,
.env-diff-pick-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

/* 边界那句话在表单底部：它决定的是「这两笔是什么身份」，读完再点发送才来得及 */
.env-diff-boundary {
  padding: 8px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-secondary);
  border-radius: 6px;
}

.env-diff-verdict {
  padding: 8px 10px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--cop-text-color-primary);
  background: var(--cop-primary-bg, #ecf5ff);
  border-radius: 6px;

  /* 结论块整块重挂（`v-if="pair"`），所以这一拍只在「新读数落定」那一刻出现，逐行滚动与换侧都不重放。
     光晕刻意压在块上而不是逐行：正文可以有几百万行，逐行动画就是把 `MAX_ANIMATED_ROWS` 那笔账
     在另一个界面重新犯一次；非颜色的差异线索已由行号后那个 `≠` 承担。 */
  animation: cop-rise-in var(--cop-duration-slow) var(--cop-ease-enter);
}

.env-diff-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.env-diff-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--cop-border-color);
  border-radius: 8px;
}

.env-diff-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  background: var(--cop-bg-color-secondary);
  border-bottom: 1px solid var(--cop-border-color);
}

.env-diff-meta-note {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  white-space: nowrap;
}

.env-diff-body {
  max-height: 320px;
  padding: 8px 0;
  overflow: auto;
  font-family: SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
}

.env-diff-line {
  display: flex;
  margin: 0;
  line-height: 1.5;
  white-space: pre-wrap;
}

.env-diff-line.is-diff {
  color: var(--el-color-danger, #f56c6c);
  background: rgb(245 108 108 / 8%);
}

/* 差异不只由颜色说：字色与底色是同一条通道上的两个读数，色觉与截图场景都读不出来。
   行号后那个 `≠` 是真文本节点（不是 CSS `content`，屏读得到），另配一句就近的屏读句子。 */
.env-diff-line-mark {
  flex-shrink: 0;
  min-width: 1.2em;
  font-weight: 700;
}

.env-diff-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip-path: inset(50%);
}

.env-diff-line-no {
  flex-shrink: 0;
  min-width: 2.5em;
  padding-right: 8px;
  color: var(--cop-text-color-secondary);
  text-align: right;
  user-select: none;
}

.env-diff-line-text {
  min-width: 0;
  word-break: break-all;
}

.env-diff-error {
  padding: 0 10px;
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger, #f56c6c);
}

.env-diff-no-body {
  padding: 0 10px;
  margin: 0;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}
</style>
