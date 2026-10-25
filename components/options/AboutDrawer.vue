<template>
  <el-drawer
    :model-value="visible"
    :title="t('aboutTitle', [t('extensionName')])"
    direction="rtl"
    size="420px"
    class="about-drawer"
    @close="$emit('update:visible', false)"
  >
    <div class="about">
      <div class="about__head">
        <span class="about__name">{{ t('extensionName') }}</span>
        <span
          class="about__version"
          :title="t('versionLinkTitle')"
          >v{{ version }}</span
        >
      </div>
      <p class="about__summary">{{ t('aboutSummary') }}</p>

      <!-- 能力清单逐条对得上实现：分流判据是 isSimpleRule，握手上不生效的那几项也照实说
           （`tests/wsCapabilitySurface.test.ts` 定的那条边界），不写「全能力支持长连接」这种话。 -->
      <p class="about__section">{{ t('aboutFeaturesTitle') }}</p>
      <ul class="about__list">
        <li
          v-for="line in features"
          :key="line"
        >
          {{ line }}
        </li>
      </ul>

      <!-- 外链簇读的是三处共用的那份清单（含「商店装的构建才出现」那道闸门），见
           composables/useProjectLinks.ts —— 这里不拼第二份地址。 -->
      <p class="about__section">{{ t('linksTitle') }}</p>
      <nav
        class="about__links"
        :aria-label="t('linksTitle')"
      >
        <a
          v-for="link in projectLinks"
          :key="link.key"
          class="about__link"
          :href="link.href"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t(link.key) }}</a
        >
      </nav>

      <!-- 隐私那三条是按代码事实写的（本地存储、无遥测、凭据只在代发那一刻展开），
           不是营销话术：改成任何一句更宽的话都必须回去对 `utils/storage.ts` 与 `utils/variables.ts`。 -->
      <p class="about__section">{{ t('aboutFactsTitle') }}</p>
      <dl class="about__facts">
        <template
          v-for="fact in facts"
          :key="fact.label"
        >
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </template>
      </dl>
      <p class="about__license">{{ t('aboutLicense') }}</p>

      <div class="about__actions">
        <!-- 评分入口沿用设置弹窗那条取舍：只在「商店装的构建」下出现，点一下只是开标签页 -->
        <el-button
          v-if="reviewUrl"
          size="small"
          @click="openReviewPage"
        >
          {{ t('aboutReview') }}
        </el-button>
        <el-button
          size="small"
          :icon="Share"
          @click="copyShareText"
        >
          {{ t('aboutShare') }}
        </el-button>
        <el-button
          size="small"
          @click="$emit('update:visible', false)"
        >
          {{ t('aboutClose') }}
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Share } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useI18n } from '@/composables/useI18n';
import { useProjectLinks } from '@/composables/useProjectLinks';
import { isStoreInstalled, storeReviewUrl } from '@/utils/storePage';
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
/** 清单只有一份：抽屉、设置弹窗那一节、弹窗底部一行读同一份，见 composable */
const projectLinks = useProjectLinks();

/** 版本只在打开这一次读 manifest——它是构建产物里的常量，不需要跟着任何状态变 */
const version = chrome.runtime.getManifest().version;

/** 商店装的构建才给评分入口（解包加载那条链接必然 404） */
const reviewUrl = isStoreInstalled(chrome.runtime.getManifest().update_url) ? storeReviewUrl(chrome.runtime.id) : '';

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

function openReviewPage() {
  if (!reviewUrl) return;
  void chrome.tabs.create({ url: reviewUrl });
}

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
  gap: 14px;
}

.about__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.about__name {
  font-size: 16px;
  font-weight: 700;
  color: var(--cop-text-color-primary);
}

.about__version {
  padding: 1px 7px;
  font-size: 12px;
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

.about__section {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--cop-text-color-secondary);
}

.about__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 18px;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--cop-text-color-regular);
}

.about__links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}

.about__link {
  font-size: 13px;
  color: var(--cop-primary);
  text-decoration: underline;
  text-underline-offset: 3px;
  border-radius: 4px;
  transition: color var(--cop-duration-instant) var(--cop-ease-standard);
}

.about__link:hover {
  color: var(--cop-primary-hover);
}

.about__link:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 2px;
}

.about__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.about__facts dt {
  font-weight: 700;
  color: var(--cop-text-color-secondary);
}

.about__facts dd {
  margin: 0;
  color: var(--cop-text-color-regular);
}

.about__license {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-secondary);
}

.about__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}
</style>
