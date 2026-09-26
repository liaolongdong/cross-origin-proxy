/**
 * 跨域代理助手 · 落地页渐进增强脚本
 *
 * 设计前提：页面在完全禁用 JavaScript 时也必须可读、可导航、可滚动。
 * 因此本脚本只做几件事，且所有依赖 JS 的视觉状态都写在样式的 `html.js` 选择器下
 * （脚本加载失败不会留下空洞）：
 * 1. 截图廊的翻页按钮 / 圆点 / 进度条驱动的自动轮播，悬停或聚焦时暂停
 *    （无 JS 时仍是可横向滑动的 scroll-snap 轨道）；
 * 2. 区块滚动淡入，并给同一容器里的 `.reveal` 编号（`--lp-rank`），让它们依次进场；
 * 3. 导航当前区块高亮；
 * 4. 小屏汉堡菜单：把开合状态镜像到 `aria-expanded`，点选链接后收起下拉
 *    （`<details>` 本身无 JS 也能开合）；
 * 5. 回顶 / 到底导轨（与第 7 项共用一份按帧合流的滚动读数通道，整页只挂一次监听）；
 * 6. 微信号一键复制（无 JS 时按钮不出现，号码本身是可选中的文本）；
 * 7. 页头下沿的滚动进度条，以及页头离顶后的投影（无 JS 时两者都不出现）；
 * 8. 首屏流程图的「数据包巡航」只在真正滚进视口后才放行（样式默认按住，循环动效不在没人看的地方跑）；
 * 9. 卡片的指针追光：把光斑坐标按帧写进 `--lp-x/--lp-y`（卡片外框按悬停缓存，不逐事件量），
 *    触摸设备与减弱动效下不绑定；
 * 10. 重写预演：把界面上四项输入交给 `assets/preview-engine.js`（`utils/urlMatcher.ts` 与
 *     `utils/dnrRules.ts` 的手工副本），当场说出这一笔命中与否、走哪条通道、两通道各改写成了什么。
 *     判据与措辞各归其位——引擎只回理由码，句子全部住在 HTML 里，脚本只负责挑出对应的那句；
 * 11. 对比表的整列高亮（CSS 选不出「鼠标所在那一列」）。
 *
 * 零依赖、零外链；`prefers-reduced-motion` 下不自动轮播、不平滑滚动、不错峰淡入，
 * 巡航与追光同样不启动。而且这个偏好是**实时**读的：系统开关在会话中途被翻动，
 * 样式里的循环动画由媒体查询自己停，JS 这一半（轮播、巡航、追光、平滑滚动）由下面的
 * `onMotionChange` 逐个停掉或续上——只在加载时取一次快照等于只兑现前半程。
 */

(() => {
  'use strict';

  const root = document.documentElement;
  root.classList.add('js');

  /* 保存 MediaQueryList 本身，而不是它「加载那一刻」的取值：偏好可以在系统设置里被改，
     改完之后页面不该继续按旧的那一份跑。 */
  const reduceMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');

  /** 当下是否要求减弱动效。所有 JS 侧的动效闸门都实时问它，不缓存答案。 */
  const reduceMotion = () => reduceMotionQuery.matches;

  /** 减弱动效开关翻转时要通知的回调，参数是「现在是否减弱」。 */
  const motionHandlers = [];

  /**
   * 登记一个「偏好变了要停 / 要续」的回调；各段动效自己决定怎么停、怎么续。
   * @param {(reduced: boolean) => void} handler 停与续的实现
   */
  const onMotionChange = handler => {
    motionHandlers.push(handler);
  };

  /* 老引擎只有 `addListener`（已废弃）；这里没有需要兼容的构建步骤，
     拿不到 `addEventListener` 就退回「按加载时的取值跑一整程」，与改之前的行为一致。 */
  if (typeof reduceMotionQuery.addEventListener === 'function') {
    reduceMotionQuery.addEventListener('change', event => {
      motionHandlers.forEach(handler => handler(event.matches));
    });
  }

  /** 用户声明减弱动效时，所有滚动都退化为瞬时滚动（每次调用现问，翻开关后下一次滚动就照着走）。 */
  const scrollBehavior = () => (reduceMotion() ? 'auto' : 'smooth');

  /**
   * 查询一组元素。
   * @param {string} selector 选择器
   * @returns {HTMLElement[]} 命中元素数组
   */
  const all = selector => Array.from(document.querySelectorAll(selector));

  /* ─────────────── 滚动读数：整页一份监听、一帧一次合流 ─────────────── */

  /**
   * 跟着滚动更新的读数（回顶导轨、页头进度条、追光的坐标缓存）共用这一条通道：
   * `scroll` / `resize` 各只挂一次，回调合进同一个 `requestAnimationFrame`（一帧最多排一次），
   * 几何量一次再分给所有读数。此前每个读数各自挂一份监听、各自读 `scrollHeight` 与
   * `innerHeight`，滚轮惯性一下就是一百多次强制布局。
   */
  const scrollTasks = [];
  let scrollFrame = null;
  let scrollListening = false;

  /** 一帧之内只量一次：滚动位置、视口高度、文档总高。 */
  const readScroll = () => ({
    y: window.scrollY || root.scrollTop || 0,
    viewport: window.innerHeight,
    height: root.scrollHeight,
  });

  const flushScroll = () => {
    scrollFrame = null;
    const metrics = readScroll();
    scrollTasks.forEach(task => task(metrics));
  };

  /** 把这一帧的活儿排进 rAF；已有一帧在途就不重复排。 */
  const queueScroll = () => {
    if (scrollFrame === null) scrollFrame = requestAnimationFrame(flushScroll);
  };

  /**
   * 注册一个「跟着滚动更新」的读数，并立刻按当前滚动位置落地一次。
   * @param {(metrics: { y: number, viewport: number, height: number }) => void} task 读数回调
   */
  const watchScroll = task => {
    if (!scrollListening) {
      scrollListening = true;
      window.addEventListener('scroll', queueScroll, { passive: true });
      window.addEventListener('resize', queueScroll);
    }
    scrollTasks.push(task);
    task(readScroll());
  };

  /* ─────────────── 1. 截图廊 ─────────────── */

  const track = document.querySelector('[data-gallery-track]');

  if (track) {
    const gallery = track.closest('.gallery');
    const slides = Array.from(track.children);
    const dotsBox = document.querySelector('[data-gallery-dots]');
    const prev = document.querySelector('[data-gallery-prev]');
    const next = document.querySelector('[data-gallery-next]');
    const progress = document.querySelector('[data-gallery-progress]');
    const label = dotsBox ? dotsBox.getAttribute('data-gallery-dots-label') || 'Go to slide $1' : '';
    let index = 0;
    let inView = false;

    /** 自动轮播与进度条共用 `.gallery-auto` 这一条时间线：填充动画播完即翻页。 */
    let autoPossible = !reduceMotion() && slides.length > 1 && Boolean(gallery && progress);

    /** 进度条只在「真的会自动轮播」时占位；不会自动轮播时整条轨道不出现，不留一段空刻度。 */
    const syncAutoable = () => {
      if (gallery) gallery.classList.toggle('gallery-autoable', autoPossible);
    };

    syncAutoable();

    /** 同步圆点选中态（`aria-current` 同时驱动样式与辅助技术）。 */
    const mark = () => {
      if (!dotsBox) return;
      Array.from(dotsBox.children).forEach((dot, i) =>
        dot.setAttribute('aria-current', i === index ? 'true' : 'false'),
      );
    };

    /** 停止自动轮播（进度条回到空轨）。 */
    const stop = () => {
      if (gallery) gallery.classList.remove('gallery-auto');
    };

    /** 重新开始一轮自动轮播；减弱动效、页面隐藏或轮播不在视口时不启动。 */
    const start = () => {
      if (!autoPossible || document.hidden || !inView) return;
      stop();
      // 移除后强制回流，保证同一动画能立即重新触发
      void gallery.offsetWidth;
      gallery.classList.add('gallery-auto');
    };

    /**
     * 跳到指定截图。
     * @param {number} i 目标序号（自动环绕）
     * @param {boolean} [resume] 是否随后恢复自动轮播
     */
    function show(i, resume) {
      index = (i + slides.length) % slides.length;
      const slide = slides[index];
      if (slide) {
        const left = slide.offsetLeft - (track.clientWidth - slide.clientWidth) / 2;
        track.scrollTo({ left: Math.max(0, left), behavior: scrollBehavior() });
      }
      mark();
      stop();
      if (resume) start();
    }

    if (dotsBox) {
      slides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-current', i === 0 ? 'true' : 'false');
        dot.setAttribute('aria-label', label.replace('$1', String(i + 1)));
        dot.addEventListener('click', () => show(i, true));
        dotsBox.appendChild(dot);
      });
    }

    if (prev) prev.addEventListener('click', () => show(index - 1, true));
    if (next) next.addEventListener('click', () => show(index + 1, true));

    if (progress) {
      progress.addEventListener('animationend', event => {
        if (event.animationName === 'lp-gallery-auto') show(index + 1, true);
      });
    }

    /* 指针在轮播上（或焦点落在控件里）时暂停：读完当前这张之前图不会翻走。
       接线不看 `autoPossible`——`is-paused` 只有与 `.gallery-auto` 同时在场才有作用，
       留着也不会画什么；反过来，按在场接线会让「中途关掉减弱动效」后没有暂停能力。 */
    if (gallery) {
      ['pointerenter', 'focusin'].forEach(evt =>
        gallery.addEventListener(evt, () => gallery.classList.add('is-paused')),
      );
      ['pointerleave', 'focusout'].forEach(evt =>
        gallery.addEventListener(evt, () => gallery.classList.remove('is-paused')),
      );
    }

    /* 手动滑动后用相交检测把圆点校准到当前可见截图。 */
    const galleryObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const i = slides.indexOf(entry.target);
          if (i !== -1 && i !== index) {
            index = i;
            mark();
          }
        });
      },
      { root: track, threshold: 0.6 },
    );
    slides.forEach(slide => galleryObserver.observe(slide));

    /* 自动轮播只在轮播真正在屏幕上时推进，避免用户读完一段回来发现图已翻走。 */
    const viewObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          inView = entry.isIntersecting;
          if (inView) start();
          else stop();
        });
      },
      { threshold: 0.35 },
    );
    viewObserver.observe(track);

    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    /* 减弱动效中途翻转：这半必须由脚本停/续。样式那份媒体查询只掐无限循环的动画，
       进度条这条 5.2s 一次性填充没有对应的关闭项（它压根不靠样式启动），
       不处理就会在用户要求减弱动效之后继续自动翻页。 */
    onMotionChange(reduced => {
      autoPossible = !reduced && slides.length > 1 && Boolean(gallery && progress);
      syncAutoable();
      if (autoPossible) start();
      else stop();
    });
  }

  /* ─────────────── 2. 滚动淡入 ─────────────── */

  const reveals = all('.reveal');

  /* 同一个父元素里的 .reveal 依次错开：十几张卡同时淡入时，读者的眼睛跟不上
     并列的变化，排个先后「一组」才像一组。样式侧是 `calc(var(--lp-rank) * 70ms)`，
     这里只负责编号，并压到 6 档封顶，避免长网格的最后一张等太久。
     编号无条件写：减弱动效下样式把那条 transition 整条关掉，这个变量压根不参与，
     中途把开关翻回来时错峰还在（按偏好来决定「写不写」就只剩一个过期的快照可依据）。 */
  const ranks = new Map();
  reveals.forEach(el => {
    const group = el.parentElement;
    const rank = ranks.has(group) ? ranks.get(group) : 0;
    ranks.set(group, rank + 1);
    el.style.setProperty('--lp-rank', String(Math.min(rank, 6)));
  });

  if (!reveals.length) {
    /* nothing to enhance */
  } else if (!('IntersectionObserver' in window)) {
    reveals.forEach(el => el.classList.add('in'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    reveals.forEach(el => revealObserver.observe(el));
  }

  /* ─────────────── 3. 导航当前区块高亮 ─────────────── */

  /* 同一批锚点在页面上存在两簇：桌面横条 `.site-nav` 与 ≤760px 的汉堡面板
     `.nav-menu-panel`。只查前者的话，窄屏下可见的那一簇永远拿不到 `aria-current`，
     选中态等于没有——所以两簇一起收，按 id 存成「一个区块对应多份链接」。 */
  const navLinks = all('.site-nav > a[href^="#"], .nav-menu-panel a[href^="#"]');

  if (navLinks.length && 'IntersectionObserver' in window) {
    const linksById = new Map();
    navLinks.forEach(a => {
      const id = a.getAttribute('href').slice(1);
      if (!linksById.has(id)) linksById.set(id, []);
      linksById.get(id).push(a);
    });
    const sections = all('main section[id]').filter(section => linksById.has(section.id));
    const navObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          navLinks.forEach(a => a.removeAttribute('aria-current'));
          (linksById.get(entry.target.id) || []).forEach(a => a.setAttribute('aria-current', 'true'));
        });
      },
      { rootMargin: '-72px 0px -62% 0px', threshold: 0 },
    );
    sections.forEach(section => navObserver.observe(section));
  }

  /* ─────────────── 4. 小屏汉堡菜单：展开状态与点选后收起 ─────────────── */

  const navMenu = document.querySelector('.nav-menu');

  if (navMenu) {
    const summary = navMenu.querySelector('summary');

    /* `<details>` 的开合状态辅助技术读得到，但面板现在带进场动画，
       显式声明 `aria-expanded` 让「按钮控制的是哪块内容」说得更清楚。 */
    const syncExpanded = () => {
      if (summary) summary.setAttribute('aria-expanded', String(navMenu.open));
    };

    navMenu.addEventListener('toggle', syncExpanded);
    navMenu.addEventListener('click', event => {
      if (event.target.closest('a')) navMenu.removeAttribute('open');
    });
    syncExpanded();
  }

  /* ─────────────── 5. 回顶 / 到底导轨 ─────────────── */

  const rail = document.querySelector('.scroll-rail');

  if (rail) {
    const top = rail.querySelector('.rail-top');
    const bottom = rail.querySelector('.rail-bottom');

    /* 读数本身与原来逐字相同，只是不再自建监听：见顶部「滚动读数」那一节。 */
    watchScroll(({ y, viewport, height }) => {
      rail.classList.toggle('at-top', y < 320);
      rail.classList.toggle('at-bottom', y + viewport >= height - 90);
    });

    if (top) top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: scrollBehavior() }));
    if (bottom)
      bottom.addEventListener('click', () => window.scrollTo({ top: root.scrollHeight, behavior: scrollBehavior() }));
  }

  /* ─────────────── 6. 微信号一键复制 ─────────────── */

  all('[data-copy]').forEach(btn => {
    const text = btn.getAttribute('data-copy');
    const okMsg = btn.getAttribute('data-copied') || 'Copied';
    const errMsg = btn.getAttribute('data-copy-failed') || 'Copy failed';
    const status = btn.parentElement ? btn.parentElement.querySelector('.copy-status') : null;
    let timer = null;

    /** 结果写在 `role="status"` 区域：按钮文字变化不一定会被辅助技术播报，这个区域会。 */
    const report = (message, ok) => {
      if (status) {
        status.textContent = message;
        status.classList.toggle('is-failed', !ok);
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (status) status.textContent = '';
        timer = null;
      }, 4000);
    };

    /** 兜底路径：非安全上下文与旧浏览器只有 execCommand 能写剪贴板，用完即删。 */
    const legacyCopy = () => {
      const box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.top = '-40px';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        // 视口外的临时 textarea 被拒绝时按复制失败处理，交给下面的提示文案
      }
      box.remove();
      return copied;
    };

    btn.addEventListener('click', async () => {
      if (!text) return;
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // 权限或焦点受限时 writeText 会 reject，落到下面的 execCommand 兜底
        }
      }
      if (!copied) copied = legacyCopy();
      report(copied ? okMsg : errMsg, copied);
    });
  });

  /* ─────────────── 7. 页头进度条与离顶投影 ─────────────── */

  const header = document.querySelector('.site-header');
  const scrollBar = document.querySelector('.scroll-progress i');

  if (header || scrollBar) {
    /**
     * 进度条改 `transform` 而不是 `width`：进度更新只走合成器，不触发重排。
     * 投影用 4px 死区，避免页面在亚像素滚动时来回擦边。
     * 两个读数共用顶部那一条按帧合流的通道，几何量一次（与回顶导轨同一帧，值也一致）。
     */
    watchScroll(({ y, viewport, height }) => {
      if (scrollBar) {
        const scrollable = height - viewport;
        const ratio = scrollable > 0 ? y / scrollable : 0;
        scrollBar.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
      }
      if (header) header.classList.toggle('is-scrolled', y > 4);
    });
  }

  /* ─────────────── 8. 首屏流程图：滚进视口才巡航 ─────────────── */

  const flow = document.querySelector('.hero-visual .flow');

  /* 循环动效在视口外照样逐帧跑，所以样式默认按住（`html.js` 下的
     `animation-play-state: paused`），由这里加上 `.is-live` 才放行。
     观察器无条件建：减弱动效下这一位不放行（画不出巡航），但偏好中途翻回来时
     当场就能续上——样式那半的媒体查询只负责「关」，帮不上「重新开」。 */
  if (flow) {
    let flowInView = false;

    const syncFlowLive = () => flow.classList.toggle('is-live', flowInView && !reduceMotion());

    if (!('IntersectionObserver' in window)) {
      flowInView = true;
      syncFlowLive();
    } else {
      const flowObserver = new IntersectionObserver(
        entries => {
          entries.forEach(entry => {
            flowInView = entry.isIntersecting;
            syncFlowLive();
          });
        },
        { threshold: 0.3 },
      );
      flowObserver.observe(flow);
    }

    onMotionChange(syncFlowLive);
  }

  /* ─────────────── 9. 卡片指针追光 ─────────────── */

  /* 光斑坐标交给样式的 `radial-gradient(... at var(--lp-x) var(--lp-y))`，脚本只写两个
     自定义属性，不碰 DOM 结构。指针事件可以比帧率更密，因此一帧只落地一次：
     最新一次位置攒进 `pending`，交给 `requestAnimationFrame` 里的 paint 统一写入。
     卡片外框不再每次移动都量：悬停跨进卡片时量一次并缓存，滚动或缩放让缓存过期
     （`getBoundingClientRect()` 会强制布局，指针事件的频率可以高过帧率）。
     触摸设备没有悬停态，也就没有可跟的光源，直接不绑定。 */
  const grids = all('.feature-grid, .tools-grid');

  if (grids.length && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let frame = null;
    let pending = null;

    /** 缓存的代次：每次滚动/缩放自增一次，跨代的那份缓存即视为过期。 */
    let epoch = 0;
    /** 最近一次量到的外框：`{ card, epoch, box }`，换卡或页面挪过才重新量。 */
    let cached = null;

    const paint = () => {
      frame = null;
      if (!pending) return;
      const { card, x, y } = pending;
      pending = null;
      card.style.setProperty('--lp-x', `${x}%`);
      card.style.setProperty('--lp-y', `${y}%`);
    };

    /* 「还是同一张卡、页面自量它以来没挪过」才复用，其余情况量一次。
       剩下的那点误差只有一种来路：指针停在同一张卡里不动，而这张卡自己在脚下被
       重新排了版（进场淡入那 18px）——下一次换卡、滚动或缩放就自愈，最多让光斑偏一点。 */
    const rectOf = card => {
      if (!cached || cached.card !== card || cached.epoch !== epoch) {
        cached = { card, epoch, box: card.getBoundingClientRect() };
      }
      return cached.box;
    };

    /**
     * 把指针位置攒成一次待写入的坐标（`pointermove`）。
     * @param {PointerEvent} event 指针事件
     */
    const onPointerMove = event => {
      const card = event.target.closest('.feature-card, .tool-card');
      if (!card) return;
      const box = rectOf(card);
      if (!box.width || !box.height) return;
      pending = {
        card,
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
      };
      if (frame === null) frame = requestAnimationFrame(paint);
    };

    /* 跨进卡片（或卡片里的任意后代）时先把这一张的外框量好。`pointerover` 会随指针
       跨边界反复冒泡，但缓存命中时它不做任何测量，正好当预热用。 */
    const onPointerOver = event => {
      const card = event.target.closest('.feature-card, .tool-card');
      if (card) rectOf(card);
    };

    /* 这两类指针事件都不取消默认动作，注册成被动监听；`removeEventListener` 只需与
       注册时的 capture 一致，共用同一个选项对象即可。 */
    const POINTER_OPTIONS = { passive: true };
    const pointerListeners = [
      ['pointerover', onPointerOver],
      ['pointermove', onPointerMove],
    ];

    const bindSpotlight = () =>
      grids.forEach(grid =>
        pointerListeners.forEach(([type, handler]) => grid.addEventListener(type, handler, POINTER_OPTIONS)),
      );
    const unbindSpotlight = () =>
      grids.forEach(grid =>
        pointerListeners.forEach(([type, handler]) => grid.removeEventListener(type, handler, POINTER_OPTIONS)),
      );

    if (!reduceMotion()) bindSpotlight();
    /* 减弱动效中途翻转：追光是脚本绑出来的，媒体查询替不了它——样式那边在
       `prefers-reduced-motion` 下把 `.feature-card::before` 整层 `display: none` 收掉，
       这里则连事件都不再挂，省下每帧的写入。 */
    onMotionChange(reduced => (reduced ? unbindSpotlight() : bindSpotlight()));

    /* 位置一变缓存就作废（跟着那一条按帧合流的滚动通道走，不自建监听）：
       下一次指针事件重新量一次，而不是每次事件都量。 */
    watchScroll(() => {
      epoch += 1;
    });
  }

  /* ─────────────── 10. 重写预演 ─────────────── */

  const tryBlock = document.querySelector('[data-try]');
  const engine = window.copRewritePreview;

  /* 判据不在这里：脚本只做「读四项 → 问引擎 → 把答案填进 HTML 里备好的那句」。
     面板本身在样式里默认不显示，只有引擎与控件都在（`try-ready`）才露出来——
     禁用脚本、脚本没加载、引擎单独缺失，读者看到的都是一段没有空洞的正文。 */
  if (tryBlock && engine) {
    /* 属性名一律小写：HTML 解析器会把属性名转成小写，`data-try-matchType` 这种写法
       在文档里根本查不到——四项输入用「字段名 → 小写属性名」成对写出，别靠大小写。 */
    const fields = [
      ['matchType', 'matchtype'],
      ['pattern', 'pattern'],
      ['target', 'target'],
      ['url', 'url'],
    ].map(([key, attr]) => [key, tryBlock.querySelector(`[data-try-${attr}]`)]);
    const verdict = tryBlock.querySelector('[data-try-verdict]');
    const extValue = tryBlock.querySelector('[data-try-ext]');
    const netValue = tryBlock.querySelector('[data-try-net]');
    const netAlt = tryBlock.querySelector('[data-try-net-alt]');
    const codeList = Array.from(tryBlock.querySelectorAll('[data-try-codes] [data-code]'));
    const divergedRow = tryBlock.querySelector('[data-try-diverged]');
    const rowOf = name => tryBlock.querySelector(`[data-row="${name}"]`);
    const extRow = rowOf('ext');
    const netRow = rowOf('net');

    /** 结论词写成 `data-*` 放在句子里，语言由 HTML 决定，脚本只挑属性名。 */
    const say = (el, key) => {
      if (el) el.textContent = key ? el.getAttribute(`data-${key}`) || '' : '';
    };

    const render = () => {
      const input = {};
      fields.forEach(([key, el]) => {
        input[key] = el ? el.value : '';
      });
      const result = engine.preview({ ...input, matchType: input.matchType || 'wildcard' });
      /* 结论那一格：归网络层管、却根本不会被应用时（引用越界，或换出来不是一个地址），
         再说「由网络层改写」就是把没发生的事画成绿的——下面那一格才说清是哪一种。 */
      let state = 'miss';
      if (!result.usable) state = 'rejected';
      else if (result.matched) state = result.channel === 'net' && result.netSkip ? 'notapplied' : result.channel;

      root.dataset.tryState = state;
      say(verdict, state);

      if (extRow) extRow.hidden = !result.matched;
      if (netRow) netRow.hidden = !result.matched;
      if (extValue) extValue.textContent = result.matched ? result.extUrl : '';

      if (netValue) netValue.textContent = result.netUrl || '';
      if (netAlt) {
        /* 措辞由 HTML 给：结论那句只能说「这两种里有一种」（它事先不知道是哪一种），
           这一格才点名。某个理由码在这里没有对应句子时，宁可这一行不出现，
           也不画一个空盒子。 */
        const altKey = result.netSkip ? `data-skip-${result.netSkip.toLowerCase()}` : '';
        const altText = altKey ? netAlt.getAttribute(altKey) || '' : '';
        netAlt.hidden = !altText;
        netAlt.textContent = altText;
      }
      if (divergedRow) divergedRow.hidden = !result.diverged;
      codeList.forEach(span => {
        span.hidden = result.codes.indexOf(span.getAttribute('data-code')) === -1;
      });
    };

    fields.forEach(([, el]) => {
      if (el) el.addEventListener('input', render);
    });

    /* 预设按钮把四项输入写成 `data-preset-*`（不带 `try-`，否则选择器会先选中按钮，
       四项输入框就全成了按钮的附属品）：读者不必先想出一个例子也能看到三种模式的差别。 */
    Array.from(tryBlock.querySelectorAll('[data-try-preset]')).forEach(button =>
      button.addEventListener('click', () => {
        fields.forEach(([key, el]) => {
          const next = button.getAttribute(`data-preset-${key.toLowerCase()}`);
          if (el && next !== null) el.value = next;
        });
        render();
      }),
    );

    root.classList.add('try-ready');
    render();
  }

  /* ─────────────── 11. 对比表：整列高亮 ─────────────── */

  /* 「鼠标所在的那一列」在 CSS 里没有选中标号（`:has()` 也只能从行往下看），所以脚本把列序号
     写成 `data-col`，样式负责把那一竖列染上底色——六列的表横向还要滚动，光有高亮行跟不住列。
     只在指针真的落在某个格子上时改一次属性，离开表格就清掉，不参与任何其他状态。 */
  all('.compare').forEach(table => {
    table.addEventListener(
      'pointermove',
      event => {
        const cell = event.target.closest('td, th');
        if (!cell) return;
        const col = Array.from(cell.parentElement.children).indexOf(cell) + 1;
        if (col > 0) table.dataset.col = String(col);
      },
      { passive: true },
    );
    table.addEventListener('pointerleave', () => {
      delete table.dataset.col;
    });
  });
})();
