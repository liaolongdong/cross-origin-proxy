import { computed, type ComputedRef } from 'vue';
import { currentLocale } from '@/utils/i18n';
import { isStoreInstalled, storeDetailUrl } from '@/utils/storePage';
import { GITHUB_ISSUES_URL, productDocsUrl, REPO_GITHUB_URL } from '@/utils/urls';

/** 一条项目外链：`key` 是界面文案键，`href` 只来自 `utils/urls.ts` 或 `utils/storePage.ts` */
export interface ProjectLink {
  key: string;
  href: string;
}

/** 清单里的四种落点；`store` 只在「这份构建从商店装的」那一次才进清单 */
type ProjectLinkId = 'repo' | 'docs' | 'store' | 'issues';

/**
 * 落点 → 文案键
 *
 * 写成 `Record<ProjectLinkId, string>` 这张形状是有意的：`tests/i18n.test.ts` 认这种键表，
 * 会把四个值当文案键去中英两份字典里各查一遍，打错一个当场红。消费侧用的是 `t(link.key)`，
 * 那是动态位点、扫描够不着——没有这张表，拼错的键会把 `linkRepo` 这种英文标识直接画到界面上。
 */
const PROJECT_LINK_KEYS: Record<ProjectLinkId, string> = {
  repo: 'linkRepo',
  docs: 'linkDocs',
  store: 'linkStore',
  issues: 'linkIssues',
};

/**
 * 项目外链清单（配置页顶栏、偏好设置弹窗、弹窗底部三处共用这一份）
 *
 * 清单只有一份，理由与 URL 只有一份相同：三处各排一遍时，「商店那一格要不要按安装来源收起」
 * 就在三处各判一遍；漏进任何一处，画出来的就是一个点开 404 的邀请。次序按「离当下多远」：
 * 先看源码，再看说明书，再去商店条目，最后提反馈。
 *
 * 语言切换会换掉「使用说明」那一条的落点（中文页 / 英文页对等，见 `tests/docs-consistency.test.ts`），
 * 所以返回的是 computed，而不是调用那一刻算死的数组。
 */
export function useProjectLinks(): ComputedRef<ProjectLink[]> {
  return computed(() => {
    const links: ProjectLink[] = [
      { key: PROJECT_LINK_KEYS.repo, href: REPO_GITHUB_URL },
      { key: PROJECT_LINK_KEYS.docs, href: productDocsUrl(currentLocale.value) },
    ];
    if (isStoreInstalled(chrome.runtime.getManifest().update_url)) {
      links.push({ key: PROJECT_LINK_KEYS.store, href: storeDetailUrl(chrome.runtime.id) });
    }
    links.push({ key: PROJECT_LINK_KEYS.issues, href: GITHUB_ISSUES_URL });
    return links;
  });
}
