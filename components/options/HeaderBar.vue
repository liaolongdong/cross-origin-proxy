<template>
  <div class="header">
    <!-- 第一行：Logo + 标题 + 版本 + 代理状态信号灯 -->
    <div class="header-title-row">
      <h1>
        <el-icon class="logo"><Promotion /></el-icon>
        {{ t('extensionName') }}
        <a
          class="version-tag-link"
          :href="GITHUB_RELEASES_PAGE_URL"
          target="_blank"
          rel="noopener noreferrer"
          :title="t('versionLinkTitle')"
        >
          <el-tag
            size="small"
            type="info"
            class="version-tag"
            >v{{ currentVersion }}</el-tag
          >
        </a>
        <span
          class="status-dot"
          :class="{ 'is-on': statusKnown && proxyEnabled, 'is-unknown': !statusKnown }"
          role="img"
          :title="t('statusDotTitle', [statusText])"
          :aria-label="statusText"
        ></span>
      </h1>

      <!-- 代理总开关：与状态灯同一行，第二行只留工具栏 -->
      <div class="proxy-toggle">
        <span class="proxy-toggle-label">{{ statusText }}</span>
        <el-switch
          :model-value="proxyEnabled"
          :aria-label="t('proxyToggleA11y')"
          @change="(val: boolean | string | number) => $emit('toggleProxy', val as boolean)"
        />
      </div>
    </div>

    <!-- 第二行：操作按钮 -->
    <div class="header-actions">
      <el-button
        type="primary"
        :icon="Plus"
        @click="$emit('addRule')"
      >
        {{ t('addRule') }}
      </el-button>
      <el-button
        :icon="Document"
        @click="$emit('openLogs')"
      >
        {{ t('tabLogs') }}
      </el-button>
      <el-button
        :icon="Search"
        @click="$emit('openUrlTest')"
      >
        {{ t('urlTest') }}
      </el-button>
      <el-button
        :icon="FolderOpened"
        @click="$emit('openImportExport')"
      >
        {{ t('importExportConfig') }}
      </el-button>
      <el-button
        :icon="Collection"
        @click="$emit('openProfiles')"
      >
        {{ t('openProfiles') }}
      </el-button>
      <el-button
        :icon="Setting"
        @click="$emit('openSettings')"
      >
        {{ t('tabSettings') }}
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Plus, Document, Search, FolderOpened, Collection, Setting, Promotion } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';
import { GITHUB_RELEASES_PAGE_URL } from '@/utils/constants';

/**
 * Options 页头部组件（135° 主题渐变通栏）
 *
 * 包含标题、可点击的版本徽标、代理状态信号灯（与代理总开关同一行），
 * 以及第二行工具栏：主操作（添加规则）与一组玻璃质感工具按钮（日志/URL 测试/导入导出/环境配置/设置）。
 * 间距与按钮皮肤对齐 account-password-helper 的顶栏实现；总开关刻意不套胶囊，见样式里的说明。
 */
const props = defineProps<{
  /** 当前插件版本号 */
  currentVersion: string;
  /** 代理总开关状态 */
  proxyEnabled: boolean;
  /** 有没有成功读到过配置：false 时信号灯与文案画「未知」，不把首轮失败说成「已禁用」 */
  statusKnown: boolean;
}>();

defineEmits<{
  /** 点击添加规则 */
  addRule: [];
  /** 打开请求日志抽屉 */
  openLogs: [];
  /** 打开 URL 匹配测试弹窗 */
  openUrlTest: [];
  /** 打开导入导出弹窗 */
  openImportExport: [];
  /** 打开环境配置弹窗 */
  openProfiles: [];
  /** 打开偏好设置弹窗 */
  openSettings: [];
  /** 切换代理总开关 */
  toggleProxy: [enabled: boolean];
}>();

const { t } = useI18n();

/** 状态灯与总开关共用同一句状态话，悬停提示也只在标题行这一处拼 */
const statusText = computed(() =>
  !props.statusKnown ? t('statusUnknown') : props.proxyEnabled ? t('statusEnabled') : t('statusDisabled'),
);
</script>

<style scoped>
/* 整块顶栏是「主色实底」，所以字色、薄膜、描边全走 on-primary 那一族令牌：
   暗色下六个主题把主色提亮到 #66b3ff ~ #98a7c2，白字只剩 1.97–2.43:1，令牌换深墨后整块一起翻。
   写死 `white` 就是绕过这次翻转——这也是以前只有按钮换了、顶栏没换的原因。 */
.header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 32px;
  margin-bottom: 24px;
  color: var(--cop-text-color-on-primary);
  background: linear-gradient(135deg, var(--cop-primary) 0%, var(--cop-primary-hover) 100%);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb) / 15%);
}

.header-title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.header-title-row h1 {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: 24px;
  font-weight: 500;
  color: var(--cop-text-color-on-primary);
}

.logo {
  margin-right: 12px;
  font-size: 28px;
  color: var(--cop-text-color-on-primary);
}

/* 版本号链接：弱化的可点击徽标，hover 提亮反馈，不争夺标题注意力。
   点开直达 GitHub Releases 查看最新版本与构建产物，与 Popup 帮助弹窗的版本链接同一心智。 */
.version-tag-link {
  display: inline-flex;
  flex-shrink: 0;
  margin-left: 10px;
  text-decoration: none;
  border-radius: 4px;
}

.version-tag-link:hover .version-tag {
  color: var(--cop-text-color-on-primary);
  background: rgb(var(--cop-on-primary-rgb) / 28%);
}

.version-tag-link:focus-visible {
  outline: 2px solid rgb(var(--cop-on-primary-rgb) / 80%);
  outline-offset: 1px;
}

.version-tag {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  color: rgb(var(--cop-on-primary-rgb) / 70%);
  cursor: pointer;
  user-select: none;
  background: rgb(var(--cop-on-primary-rgb) / 15%);
  border-color: rgb(var(--cop-on-primary-rgb) / 20%);
  transition:
    color var(--cop-duration-fast) var(--cop-ease-standard),
    background-color var(--cop-duration-fast) var(--cop-ease-standard);
}

/* 代理状态信号灯：一眼可见的红绿小圆点
   切换时除了换色，还在点亮的那一档跑一次光环（一次性，不循环）——
   总开关是这一页最要紧的结论，光环让「刚刚变了」这件事不必靠余光去发现。
   光环叠在常驻的那圈边上，收尾正好落回常驻值，动画结束没有跳变。
   两圈都取 on-primary 通道：底色是主色实底，暗色下那一族翻成深墨，光环才始终与底相反。 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 10px;
  cursor: help;
  background: var(--el-color-danger, #f56c6c);
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgb(var(--cop-on-primary-rgb) / 35%);
  transition:
    background-color var(--cop-duration-base) var(--cop-ease-standard),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard);
}

/* 悬停提示由原生 title 承载（与参考实现的健康信号灯同一做法）；
   光圈只负责说「这里有东西可看」，不改变红绿结论 */
.status-dot:hover {
  box-shadow:
    0 0 0 2px rgb(var(--cop-on-primary-rgb) / 35%),
    0 0 0 5px rgb(var(--cop-on-primary-rgb) / 18%);
}

.status-dot.is-on {
  background: var(--el-color-success, #67c23a);
  animation: dot-flare var(--cop-duration-slow) var(--cop-ease-standard) 1;
}

/* 还没有读到过总开关状态：红点是「已关闭」这条结论，这时不画它，改用中性半透明点 */
.status-dot.is-unknown {
  background: rgb(var(--cop-on-primary-rgb) / 45%);
}

@keyframes dot-flare {
  from {
    box-shadow:
      0 0 0 2px rgb(var(--cop-on-primary-rgb) / 35%),
      0 0 0 0 rgb(var(--cop-on-primary-rgb) / 65%);
  }

  to {
    box-shadow:
      0 0 0 2px rgb(var(--cop-on-primary-rgb) / 35%),
      0 0 0 9px rgb(var(--cop-on-primary-rgb) / 0%);
  }
}

/* 间距与 button skin 对齐 account-password-helper 的顶栏：
   工具之间 12px，`.el-button + .el-button` 的默认 12px 外边距在下面归零，
   间距只由 gap 说一次（否则实际会变成 24px，正是旧顶栏看起来松散的原因）。 */
.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.header-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* 工具按钮是玻璃胶囊：15% on-primary 底 + 25% 边（亮色下即白色，暗色随令牌翻成深墨），
   悬停提到 20% / 40% 并抬 1px。与主操作的白色实心区分层级，但六颗仍读作同一条工具栏，
   而不是六个互不相干的操作。
   显式列过渡属性而不是 `all`：`all` 会把语言切换时变化的按钮宽度也纳入过渡。 */
:deep(.header-actions .el-button) {
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 400;
  color: var(--cop-text-color-on-primary);
  background: rgb(var(--cop-on-primary-rgb) / 15%);
  border: 1px solid rgb(var(--cop-on-primary-rgb) / 25%);
  backdrop-filter: blur(10px);
  transition:
    color var(--cop-duration-instant) var(--cop-ease-standard),
    background-color var(--cop-duration-instant) var(--cop-ease-standard),
    border-color var(--cop-duration-instant) var(--cop-ease-standard),
    box-shadow var(--cop-duration-instant) var(--cop-ease-standard),
    transform var(--cop-duration-instant) var(--cop-ease-enter);
}

:deep(.header-actions .el-button:not(.el-button--primary):hover) {
  background: rgb(var(--cop-on-primary-rgb) / 20%);
  border-color: rgb(var(--cop-on-primary-rgb) / 40%);
  box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  transform: translateY(-1px);
}

:deep(.header-actions .el-button:not(.el-button--primary):active) {
  background: rgb(var(--cop-on-primary-rgb) / 24%);
  box-shadow: 0 1px 4px rgb(0 0 0 / 12%);
  transform: translateY(0);
}

/* 键盘焦点环走 on-primary 通道，暗色下随顶栏一起翻成深墨；EP 默认环在渐变底上不够显眼 */
:deep(.header-actions .el-button:focus-visible) {
  outline: 2px solid rgb(var(--cop-on-primary-rgb) / 70%);
  outline-offset: 2px;
}

/* 多带一个 `.el-button` 是承重的：`entrypoints/options/styles.css` 里暗色模式那条
   `:root[data-mode='dark'] .el-button--primary` 与本选择器同为 3 个类级权重，而它排在
   组件样式之后，于是暗色的 on-primary 深墨字色会盖掉这里反色按钮的 `--cop-primary`——
   深墨字压在深色底上，按钮文字等于消失。加上 `.el-button` 抬到 4 个类级，
   胜负不再由样式表顺序决定。 */
:deep(.header-actions .el-button.el-button--primary) {
  padding: 0 14px;
  font-weight: 500;
  color: var(--cop-primary);
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-bg-color);
  transition:
    color var(--cop-duration-instant) var(--cop-ease-standard),
    background-color var(--cop-duration-instant) var(--cop-ease-standard),
    border-color var(--cop-duration-instant) var(--cop-ease-standard),
    box-shadow var(--cop-duration-instant) var(--cop-ease-standard),
    transform var(--cop-duration-instant) var(--cop-ease-enter);
}

:deep(.header-actions .el-button--primary:hover) {
  color: var(--cop-primary);
  background: var(--cop-surface-hover);
  border-color: var(--cop-surface-hover);
  box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  transform: translateY(-1px);
}

:deep(.header-actions .el-button--primary:active) {
  box-shadow: 0 1px 4px rgb(0 0 0 / 12%);
  transform: translateY(0);
}

/* 总开关：不套胶囊。顶栏本身就是主色实底，再包一层薄膜等于在同一行里叠出第三个
   盒子（标题、按钮条之外），而它 44px 的高度还是这一行最高的东西——「看着没对齐」
   其实是被它拽下去的。这里只留「状态话 + 开关」，行高交还给标题自己。 */
.proxy-toggle {
  display: inline-flex;
  flex-shrink: 0;
  gap: 10px;
  align-items: center;
}

.proxy-toggle-label {
  font-size: 13px;
  font-weight: 500;
  color: rgb(var(--cop-on-primary-rgb) / 92%);
  user-select: none;
}

/* 开关本体：两态靠「空 / 满」分开，不靠颜色深浅。
   关掉态 = 空心：轨道不填色，只留一圈描边，滑块收成七成不透明度；
   开启态 = 实心：整条轨道填满 on-primary，滑块反过来透出渐变右端的底色，
   像从轨道上打了一个孔。
   为什么不用 Element Plus 那抹默认灰（#dcdfe6）：按带薄膜胶囊那版实拍量过，轨道对底
   只有 1.50:1、白滑块对灰轨道 1.34:1，旋钮找不着；而上一版把关掉态画成「压暗的实心
   轨道 + 纯白滑块」，两态都是实心，用户实拍反馈「看不出是开着还是关着」。
   形状层面的空/满比位置（滑块在左在右）更好读，暗色下 on-primary 翻成深墨，两态一起翻。 */
:deep(.proxy-toggle .el-switch) {
  height: 20px;
}

:deep(.proxy-toggle .el-switch__core) {
  background: transparent;
  border-color: rgb(var(--cop-on-primary-rgb) / 55%);
  transition:
    background-color var(--cop-duration-base) var(--cop-ease-enter),
    border-color var(--cop-duration-base) var(--cop-ease-enter);
}

:deep(.proxy-toggle .el-switch:hover .el-switch__core) {
  border-color: rgb(var(--cop-on-primary-rgb) / 78%);
}

:deep(.proxy-toggle .el-switch__core .el-switch__action) {
  background: rgb(var(--cop-on-primary-rgb) / 72%);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
  transition:
    left var(--cop-duration-base) var(--cop-ease-enter),
    background-color var(--cop-duration-fast) var(--cop-ease-standard);
}

:deep(.proxy-toggle .el-switch.is-checked .el-switch__core) {
  background: rgb(var(--cop-on-primary-rgb) / 100%);
  border-color: rgb(var(--cop-on-primary-rgb) / 100%);
}

:deep(.proxy-toggle .el-switch.is-checked .el-switch__core .el-switch__action) {
  background: var(--cop-primary-hover);
  box-shadow: none;
}

/* 焦点环也走 on-primary：EP 默认用 --el-switch-on-color（即主题蓝）描边，
   而这一层底色就是主色渐变，蓝环压在蓝底上等于看不见 */
:deep(.proxy-toggle .el-switch__input:focus-visible ~ .el-switch__core) {
  outline: 2px solid rgb(var(--cop-on-primary-rgb) / 80%);
  outline-offset: 2px;
}

/* 响应式 */
@media (width <= 768px) {
  .header {
    padding: 20px;
  }

  .header-title-row h1 {
    font-size: 20px;
  }

  /* 六颗按钮挤在一行会掉成 5 + 1（「设置」孤零零居中）。
     3 列网格让它们整齐地排成两行三颗，每颗等宽、命中区也更大。 */
  .header-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
  }

  .header-actions :deep(.el-button) {
    width: 100%;
  }
}

/* 极窄窗口再退一档：三列放不下「导入/导出配置」时改两列 */
@media (width <= 560px) {
  .header-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
