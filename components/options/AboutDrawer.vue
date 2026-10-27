<template>
  <el-drawer
    :model-value="visible"
    :title="t('about')"
    direction="rtl"
    size="420px"
    class="about-drawer"
    @close="$emit('update:visible', false)"
  >
    <div class="about">
      <div class="about__brand">
        <img
          class="about__logo"
          src="/icon/96.png"
          width="32"
          height="32"
          alt=""
        />
        <div class="about__brand-text">
          <span class="about__name">{{ t('extensionName') }}</span>
          <span class="about__version">v{{ version }}</span>
        </div>
      </div>
      <p class="about__summary">{{ t('aboutSummary') }}</p>

      <!-- 数据事实卡：三条按代码事实写（本地存储、无遥测、凭据只留引用），
           改成任何一句更宽的话都必须回去对 `utils/storage.ts` 与 `utils/variables.ts`。 -->
      <dl class="about__facts">
        <div
          v-for="fact in facts"
          :key="fact.label"
          class="about__fact"
        >
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </div>
      </dl>

      <!-- 外链读的是三处共用的那份清单 + 抽屉自己的补充出口（见 composables/useProjectLinks.ts）；
           这里不拼任何地址。主机名从 href 现取，不写第二份。 -->
      <p class="about__section">{{ t('linksTitle') }}</p>
      <nav
        class="about__links"
        :aria-label="t('linksTitle')"
      >
        <ul class="about__link-list">
          <li
            v-for="link in allLinks"
            :key="link.key"
          >
            <a
              :href="link.href"
              class="about-link"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="link.ariaLabel"
            >
              <span class="about-link__label">{{ link.label }}</span>
              <span class="about-link__host">{{ link.host }}</span>
              <el-icon
                class="about-link__icon"
                aria-hidden="true"
              >
                <TopRight />
              </el-icon>
            </a>
          </li>
        </ul>
      </nav>

      <!-- 能力清单是补充阅读：默认收起，让「数据事实 + 出口」留在首屏；展开后逐条对得上实现
           （分流判据是 isSimpleRule，握手上不生效的那几项也照实说，见 tests/wsCapabilitySurface.test.ts）。 -->
      <details class="about__more">
        <summary class="about__section">{{ t('aboutFeaturesTitle') }}</summary>
        <ul class="about__features">
          <li
            v-for="line in features"
            :key="line"
          >
            {{ line }}
          </li>
        </ul>
      </details>

      <p class="about__license">{{ t('aboutLicense') }}</p>
    </div>

    <template #footer>
      <div class="about__footer">
        <el-button
          :icon="Share"
          @click="copyShareText"
        >
          {{ t('aboutShare') }}
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Share, TopRight } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useI18n } from '@/composables/useI18n';
import { useAboutMoreLinks, useProjectLinks, type ProjectLink } from '@/composables/useProjectLinks';
import { PRODUCT_DOCS_URL } from '@/utils/urls';

defineOptions({ name: 'AboutDrawer' });

// 受控可见性：模板直接读 `visible`，这里不需要那份 props 引用
defineProps<{
  visible: boolean;
}>();

defineEmits<{
  'update:visible': [value: boolean];
}>();

const { t } = useI18n();

/** 共享四条（设置弹窗与弹窗底部读的也是这一份）+ 抽屉自己的补充出口 */
const projectLinks = useProjectLinks();
const moreLinks = useAboutMoreLinks();

/** 版本只在打开这一次读 manifest——它是构建产物里的常量，不需要跟着任何状态变 */
const version = chrome.runtime.getManifest().version;

/** 能力清单：`computed` 而不是常量，抽屉开着切语言也得跟着换 */
const features = computed(() => [
  t('aboutFeature1'),
  t('aboutFeature2'),
  t('aboutFeature3'),
  t('aboutFeature4'),
  t('aboutFeature5'),
  t('aboutFeature6'),
  t('aboutFeature7'),
]);

const facts = computed(() => [
  { label: t('aboutFactStorage'), value: t('aboutFactStorageValue') },
  { label: t('aboutFactTelemetry'), value: t('aboutFactTelemetryValue') },
  { label: t('aboutFactCredentials'), value: t('aboutFactCredentialsValue') },
]);

/**
 * 把清单落成「标签 / 主机名 / 无障碍名称」三件套
 *
 * 主机名从 href 现取，不另写一份；无障碍名称拼上「新标签页打开」，箭头本身对读屏不可见。
 * 名称以可见标签开头，满足 WCAG 2.5.3（label in name）。
 */
function toRows(links: ProjectLink[]) {
  return links.map(link => ({
    key: link.key,
    href: link.href,
    label: t(link.key),
    host: new URL(link.href).host,
    ariaLabel: `${t(link.key)}${t('linkNewTabSuffix')}`,
  }));
}

const allLinks = computed(() => toRows([...projectLinks.value, ...moreLinks.value]));

/**
 * 复制一句推荐语（带产品页地址，不带扩展 ID）
 *
 * 落点刻意是 `PRODUCT_DOCS_URL` 而不是商店条目页：那条由 ID 现拼，解包加载与别的商店分发下
 * 指向的就是一个不存在的条目，而分享出去的链接要能被任何人打开。
 */
async function copyShareText() {
  const text = t('aboutShareText', [PRODUCT_DOCS_URL]);
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t('aboutShareCopied'));
  } catch {
    ElMessage.error(t('aboutShareFailed'));
  }
}
</script>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.about__brand {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--cop-border-color-light);
}

.about__logo {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.about__brand-text {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.about__name {
  font-size: 16px;
  font-weight: 700;
  color: var(--cop-text-color-primary);
}

.about__version {
  padding: 1px 7px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 999px;
}

.about__summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--cop-text-color-regular);
}

/* 事实卡：截图那套把「数据去哪儿了」做成一块着色底板，三行标签在上、值在下。
   竖排而不是左右两列——英文值比中文长，并排时值列会被压窄、两种语言折行数不一致。 */
.about__facts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  margin: 0;
  background: var(--cop-primary-bg);
  border: 1px solid var(--cop-primary-border);
  border-radius: 10px;
}

.about__fact dt {
  margin-bottom: 2px;
  font-size: 12px;
  font-weight: 700;
  color: var(--cop-text-color-primary);
}

.about__fact dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-secondary);
  overflow-wrap: anywhere;
}

.about__section {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--cop-text-color-secondary);
}

.about__links {
  margin-top: -6px;
}

.about__link-list {
  padding: 0;
  margin: 0;
  list-style: none;
}

/* 标签左、目标主机右、箭头收尾。两个文本列都套 minmax(0, …)，
   长主机在窄抽屉里省略成 …，不会把抽屉撑出横向滚动。 */
.about-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, auto) 16px;
  gap: 8px;
  align-items: center;
  padding: 9px 6px;
  color: var(--cop-text-color-regular);
  text-decoration: none;
  border-radius: 6px;
  transition: background-color var(--cop-duration-fast) var(--cop-ease-standard);
}

.about-link:hover {
  background: var(--cop-surface-hover);
}

.about-link:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 2px;
}

.about-link__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--cop-primary);
  white-space: nowrap;
}

.about-link__host {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  text-align: right;
  white-space: nowrap;
}

.about-link__icon {
  color: var(--cop-text-color-secondary);
}

.about__more {
  margin: 0;
}

.about__more summary {
  cursor: pointer;
}

.about__features {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 18px;
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-regular);
}

.about__license {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-secondary);
}

.about__footer {
  display: flex;
  justify-content: flex-end;
}
</style>
