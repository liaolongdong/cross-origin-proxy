import { createAndMountApp } from '@/utils/createVueApp';
import App from './App.vue';
// ElMessage / ElMessageBox 为显式导入（非自动解析），按需样式需手动补齐。
// message-box 这一行是承重的：LogDrawer 的「清空日志」确认框走 ElMessageBox，
// 漏掉它之后弹窗没有定位与宽度（正文贴左上、文字挤成竖条），与 options/main.ts 同一份清单
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import '@/assets/theme/tokens.css';
import { initThemeSync } from '@/utils/theme';
import { initLocaleSync, t } from '@/utils/i18n';

// 与 popup 同一套装配：主题先按 localStorage 镜像定色再异步对齐 storage，
// i18n 同理（storage.onChanged 对所有扩展页生效，侧边栏与弹窗/配置页随时保持同语言）
initThemeSync();
initLocaleSync();

// 页面标题走自研 i18n（随应用内语言，而非浏览器语言）
document.title = t('sidePanelTitle');

createAndMountApp(App);
