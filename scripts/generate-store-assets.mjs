/**
 * 商店与落地页素材生成脚本。
 *
 * 背景约束：
 * - Chrome Web Store 对截图做**像素级**校验，只接受 1280×800 或 640×400，最多 5 张；
 *   推广图块固定为 440×280（小图块）与 1400×560（跑马灯图块）。
 * - GitHub Pages / README 需要的是「体积可控的网页图」，与商店原图诉求不同。
 *
 * 因此统一从 `screenshots/` 的原始截图派生两套产物，避免手工在绘图工具里反复调尺寸：
 * - `store-assets/`：商店上传原图（精确尺寸 PNG）。属于可再生的构建产物，已加入 .gitignore。
 * - `docs/assets/`：落地页 / Open Graph 用图（压缩 JPG + PNG）。需要入库，Pages 直接托管。
 *
 * 用法：
 *   node scripts/generate-store-assets.mjs          # 中文文案（默认）
 *   node scripts/generate-store-assets.mjs --en     # 英文文案（用于英文本地化列表）
 */
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LANG = process.argv.includes('--en') ? 'en' : 'zh';

/** 品牌色，取自 `assets/theme/tokens.css` 的 sky 主题主色，保证与产品 UI 一致。 */
const BRAND = {
  primary: '#409eff',
  primarySoft: '#66b3ff',
  deep: '#0f2b52',
  deepAlt: '#1a5fb4',
  ink: '#1f2d3d',
  inkSoft: '#5b6b7c',
  page: '#f2f7ff',
  pageAlt: '#e6f0ff',
  line: '#d9e6f5',
  white: '#ffffff',
};

const STORE_DIR = resolve(ROOT, `store-assets/screenshots-${LANG}`);
const TILE_DIR = resolve(ROOT, 'store-assets/tiles');
const WEB_IMG_DIR = resolve(ROOT, 'docs/assets/img');

/** 商店截图尺寸（Chrome 硬性要求）。 */
const SHOT_W = 1280;
const SHOT_H = 800;
/** 截图页版式：顶部说明区 + 居中圆角截图。 */
const PAD_X = 56;
const CAPTION_H = 118;

/**
 * 参与导出的截图。最多取前 5 张上传 Chrome Web Store，第 6 张仅用于落地页。
 * @type {Array<{ file: string, slug: string, alt: Record<string, string>, caption: Record<string, { title: string, sub: string }> }>}
 */
const SHOTS = [
  {
    file: 'opt-options-main.png',
    slug: '01-rules-overview',
    alt: { zh: '规则总览页', en: 'Rules overview' },
    caption: {
      zh: {
        title: '一条规则，把 FAT 前端指到 UAT 后端',
        sub: '通配符 / 前缀 / 正则匹配，拖拽排序优先级，能力徽标一眼看清',
      },
      en: {
        title: 'Point a FAT frontend at a UAT backend with one rule',
        sub: 'Wildcard / prefix / regex matching, drag-to-reorder priority, capability badges',
      },
    },
  },
  {
    file: 'opt-rule-dialog.png',
    slug: '02-rule-editor',
    alt: { zh: '规则编辑弹窗', en: 'Rule editor dialog' },
    caption: {
      zh: { title: '重写、Mock、延迟、阻断，一处配齐', sub: '请求头 / 请求体 / 响应字段改写，支持按 HTTP 方法限定' },
      en: {
        title: 'Rewrite, mock, delay and block in one form',
        sub: 'Header / body / response field overrides with HTTP method filtering',
      },
    },
  },
  {
    file: 'opt-rule-test.png',
    slug: '03-url-tester',
    alt: { zh: 'URL 匹配预演', en: 'URL match tester' },
    caption: {
      zh: { title: '上线前先预演：这条 URL 命中谁', sub: '实时显示命中规则、重写后的地址、转发通道与被遮蔽规则' },
      en: {
        title: 'Preview which rule a URL hits before you ship',
        sub: 'Matched rule, rewritten URL, forwarding channel and shadowed rules in real time',
      },
    },
  },
  {
    file: 'opt-log-drawer.png',
    slug: '04-request-log',
    alt: { zh: '请求日志抽屉', en: 'Request log drawer' },
    caption: {
      zh: { title: '每一次代理都可复盘', sub: '方法 / 状态 / 耗时 / DNR 命中统计，一键复制为 cURL 或导出 HAR' },
      en: {
        title: 'Every proxied request is reviewable',
        sub: 'Method / status / duration / DNR hits, copy as cURL or export HAR',
      },
    },
  },
  {
    file: 'opt-popup.png',
    slug: '05-popup',
    alt: { zh: '弹窗快速开关', en: 'Popup quick panel' },
    caption: {
      zh: { title: '开关一按即生效，当前页命中看得见', sub: '全局开关、今日统计、自动关闭倒计时与当前页面命中预演' },
      en: {
        title: 'Toggle and see the current page match instantly',
        sub: 'Global switch, today stats, auto-off countdown and page hit preview',
      },
    },
  },
  {
    file: 'opt-dark-mode.png',
    slug: '06-dark-theme',
    alt: { zh: '深色主题', en: 'Dark theme' },
    caption: {
      zh: { title: '6 套主题 + 深色模式', sub: '中英双语界面，跟随系统或手动切换' },
      en: { title: 'Six themes plus dark mode', sub: 'Bilingual UI, follow the system or switch manually' },
    },
  },
];

/** 转义 XML 文本，避免 `&` `<` `>` 破坏 SVG。 */
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 生成线性渐变背景 SVG 片段。 */
function gradient(id, from, to, angle = 'x1="0" y1="0" x2="1" y2="1"') {
  return `<linearGradient id="${id}" ${angle}><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
}

/** 统一的字体栈：优先中文可用的系统字体，保证 CJK 标题不塌成方框。 */
const FONT = 'PingFang SC, Helvetica Neue, Arial, sans-serif';

async function writeSvgPng(svg, width, height, outFile) {
  await sharp(Buffer.from(svg)).resize(width, height, { fit: 'outside' }).png().toFile(outFile);
}

/**
 * 把截图裁成圆角（用 dest-in 混合一张圆角蒙版），使其在浅色底上更精致。
 */
async function roundCorners(image, width, height, radius) {
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/>
  </svg>`;
  return sharp(image)
    .composite([{ input: Buffer.from(mask), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * 合成一张商店截图：浅色渐变底 + 标题说明 + 圆角截图 + 描边。
 */
async function buildScreenshot(shot) {
  const source = resolve(ROOT, 'screenshots', shot.file);
  const meta = await sharp(source).metadata();
  const boxW = SHOT_W - PAD_X * 2;
  const boxH = SHOT_H - CAPTION_H - 44;
  const scale = Math.min(boxW / meta.width, boxH / meta.height);
  const drawW = Math.round(meta.width * scale);
  const drawH = Math.round(meta.height * scale);
  const x = Math.round((SHOT_W - drawW) / 2);
  const y = CAPTION_H + Math.round((boxH - drawH) / 2);
  const { title, sub } = shot.caption[LANG];

  const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHOT_W}" height="${SHOT_H}">
    <defs>${gradient('bg', BRAND.page, BRAND.pageAlt)}</defs>
    <rect width="${SHOT_W}" height="${SHOT_H}" fill="url(#bg)"/>
    <rect x="${PAD_X}" y="40" width="6" height="52" rx="3" fill="${BRAND.primary}"/>
    <text x="${PAD_X + 22}" y="72" font-family="${FONT}" font-size="34" font-weight="600" fill="${BRAND.ink}">${esc(title)}</text>
    <text x="${PAD_X + 22}" y="100" font-family="${FONT}" font-size="21" fill="${BRAND.inkSoft}">${esc(sub)}</text>
  </svg>`;

  const resized = await sharp(source).resize(drawW, drawH, { fit: 'fill' }).png().toBuffer();
  const rounded = await roundCorners(resized, drawW, drawH, 12);
  const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHOT_W}" height="${SHOT_H}">
    <rect x="${x - 0.5}" y="${y - 0.5}" width="${drawW + 1}" height="${drawH + 1}" rx="12" fill="none" stroke="${BRAND.line}"/>
  </svg>`;

  const out = resolve(STORE_DIR, `${shot.slug}.png`);
  await sharp(Buffer.from(base))
    .composite([
      { input: rounded, left: x, top: y },
      { input: Buffer.from(frame), left: 0, top: 0 },
    ])
    .png()
    .toFile(out);
  console.log(`store  ${LANG}  ${shot.slug}.png  ${SHOT_W}x${SHOT_H}`);
}

/** 落地页用图：保持 16:10，转 JPG 控制首屏体积。 */
async function buildWebImage(shot) {
  const source = resolve(ROOT, 'screenshots', shot.file);
  const out = resolve(WEB_IMG_DIR, `${shot.slug.replace(/^\d+-/, '')}.jpg`);
  await sharp(source)
    .resize(1200, 750, { fit: 'inside' })
    .jpeg({ quality: 74, progressive: true, mozjpeg: true })
    .toFile(out);
  console.log(`web    ${shot.slug.replace(/^\d+-/, '')}.jpg`);
}

/** 品牌底图（图块 / Open Graph 共用版式）。 */
function brandCanvas(width, height, { title, tagline, chips, url, titleSize }) {
  const chipH = 52;
  const chipFont = 23;
  /** 胶囊宽度按文字实宽估算：CJK 约 1em，拉丁约 0.58em，空格约 0.3em，左右各留 26px。 */
  const measure = text =>
    [...text].reduce((sum, ch) => {
      const weight = ch.codePointAt(0) > 0x7f ? 1 : ch === ' ' ? 0.3 : 0.58;
      return sum + chipFont * weight;
    }, 0);
  let cursor = 88;
  const chipsSvg = (chips || [])
    .map(chip => {
      const chipW = Math.round(measure(chip)) + 52;
      const cx = cursor;
      cursor += chipW + 18;
      const cy = height - 150;
      return `<g><rect x="${cx}" y="${cy}" width="${chipW}" height="${chipH}" rx="26" fill="#ffffff" fill-opacity="0.14" stroke="#ffffff" stroke-opacity="0.35"/>
        <text x="${cx + chipW / 2}" y="${cy + 34}" text-anchor="middle" font-family="${FONT}" font-size="${chipFont}" fill="#eaf3ff">${esc(chip)}</text></g>`;
    })
    .join('');
  const iconSize = Math.round(height * 0.24);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      ${gradient('bg', BRAND.deep, BRAND.deepAlt)}
      <radialGradient id="glow" cx="0.82" cy="0.18" r="0.6">
        <stop offset="0" stop-color="${BRAND.primary}" stop-opacity="0.55"/>
        <stop offset="1" stop-color="${BRAND.primary}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
    <image x="${width - iconSize - 72}" y="56" width="${iconSize}" height="${iconSize}" href="${ICON_DATA_URL}"/>
    <text x="88" y="${height * 0.48}" font-family="${FONT}" font-size="${titleSize}" font-weight="700" fill="#ffffff">${esc(title)}</text>
    <text x="88" y="${height * 0.48 + titleSize * 0.78}" font-family="${FONT}" font-size="${Math.round(titleSize * 0.42)}" fill="#cfe3ff">${esc(tagline)}</text>
    ${chipsSvg}
    ${url ? `<text x="88" y="${height - 56}" font-family="${FONT}" font-size="24" fill="#9fc6f5">${esc(url)}</text>` : ''}
  </svg>`;
}

const ICON_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(readFileSync(resolve(ROOT, 'public/icon.svg'))).toString('base64')}`;

const TILE_COPY = {
  zh: {
    title: '跨域代理助手',
    tagline: '免改代码与 CORS，把前端 API 指到任意环境',
    chips: ['环境切换', '请求改写', 'Mock / 延迟 / 阻断', 'WebSocket'],
  },
  en: {
    title: 'Cross-Origin Proxy',
    tagline: 'Route frontend API calls to any environment — no code or CORS changes',
    chips: ['Env switch', 'Rewrite', 'Mock / Delay / Block', 'WebSocket'],
  },
};

async function buildTiles() {
  const copy = TILE_COPY[LANG];
  /** 图块名携带语言后缀，避免 `--en` 重跑时覆盖中文版；仓库社交预览图全局只出一份（英文，面向 GitHub 受众）。 */
  const jobs = [
    { name: `marquee-${LANG}`, width: 1400, height: 560, titleSize: 68 },
    { name: `small-tile-${LANG}`, width: 440, height: 280, titleSize: 34 },
    { name: `og-image-${LANG}`, width: 1200, height: 630, titleSize: 62 },
  ];
  if (LANG === 'en') jobs.push({ name: 'github-social-preview', width: 1280, height: 640, titleSize: 64 });
  for (const job of jobs) {
    const compact = job.width < 600;
    const svg = brandCanvas(job.width, job.height, {
      title: copy.title,
      tagline: compact ? '' : copy.tagline,
      chips: compact ? [] : copy.chips,
      url:
        job.name.startsWith('og-image') || job.name === 'github-social-preview'
          ? 'GH_OWNER.github.io/cross-origin-proxy'
          : '',
      titleSize: job.titleSize,
    });
    const dir = job.name.startsWith('og-image') ? resolve(ROOT, 'docs/assets') : TILE_DIR;
    await writeSvgPng(svg, job.width, job.height, resolve(dir, `${job.name}.png`));
    console.log(`tile   ${job.name}.png  ${job.width}x${job.height}`);
  }
}

async function main() {
  for (const dir of [STORE_DIR, TILE_DIR, WEB_IMG_DIR, resolve(ROOT, 'docs/assets')]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const shot of SHOTS) {
    if (LANG === 'zh') await buildWebImage(shot);
    if (shot.slug !== '06-dark-theme') await buildScreenshot(shot);
  }
  await buildTiles();
  console.log(`\nDone (lang=${LANG}). 商店图在 store-assets/，落地页图在 docs/assets/img/。`);
}

await main();
