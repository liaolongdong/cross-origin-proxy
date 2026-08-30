import { createAndMountApp } from '@/utils/createVueApp';
import App from '@/components/options/App.vue';
// Element Plus 样式走按需引入（wxt.config 中 ElementPlusResolver importStyle:'css'），
// 不再全量导入 element-plus/dist/index.css（约 360KB）；
// ElMessage/ElMessageBox 为显式导入（非自动解析），其样式需手动补齐
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import '@/assets/theme/tokens.css';
import './styles.css';
import { initThemeSync } from '@/utils/theme';
import { initLocaleSync, t } from '@/utils/i18n';

initThemeSync();
initLocaleSync();

// 页面标题走自研 i18n（随应用内语言，而非浏览器语言）
document.title = t('optionsPageTitle');

createAndMountApp(App);
