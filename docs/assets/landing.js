/**
 * 跨域代理助手 · 落地页渐进增强脚本
 *
 * 设计前提：页面在完全禁用 JavaScript 时也必须可读、可导航、可滚动。
 * 因此本脚本只做几件事，且所有依赖 JS 的视觉状态都写在样式的 `html.js` 选择器下
 * （脚本加载失败不会留下空洞）：
 * 1. 截图廊的翻页按钮 / 圆点 / 进度条驱动的自动轮播，悬停或聚焦时暂停
 *    （无 JS 时仍是可横向滑动的 scroll-snap 轨道）；
 * 2. 区块滚动淡入，并给同一容器里的 `.reveal` 编号（`--lp-rank`），让它们依次进场；
 * 3. 导航当前区块高亮，外加锚点条自己的横向滚动（放不下时它才滚：截断在哪一侧写进
 *    `data-edge`，高亮那一项自动滚进视野，竖滚轮在条上转成横滚、到头就交还页面）；
 * 4. 小屏汉堡菜单：把开合状态镜像到 `aria-expanded`；三种收起方式——再点一次按钮（原生）、
 *    点面板之外、Esc（并把焦点交还按钮），点选链接后同样收起（`<details>` 本身无 JS 也能开合）；
 * 5. 回顶 / 到底导轨（与第 7 项共用一份按帧合流的滚动读数通道，整页只挂一次监听）；
 * 6. 一键复制：微信号与预演面板共用同一条剪贴板路径（按钮文字不保证被播报，结果另写进
 *    `role="status"` 区域，4 秒后收回）；无 JS 时按钮不出现，号码本身是可选中的文本；
 * 7. 页头下沿的滚动进度条，以及页头离顶后的投影（无 JS 时两者都不出现）；
 * 8. 首屏流程图的「数据包巡航」只在真正滚进视口后才放行（样式默认按住，循环动效不在没人看的地方跑）；
 * 9. 卡片的指针追光：把光斑坐标按帧写进 `--lp-x/--lp-y`（卡片外框按悬停缓存，不逐事件量），
 *    触摸设备与减弱动效下不绑定；
 * 10. 重写预演：把界面上四项输入交给 `assets/preview-engine.js`（`utils/urlMatcher.ts` 与
 *     `utils/dnrRules.ts` 的手工副本），当场说出这一笔命中与否、走哪条通道、两通道各改写成了什么。
 *     判据与措辞各归其位——引擎只回理由码，句子全部住在 HTML 里，脚本只负责挑出对应的那句；
 *     预演通过时再把这一笔折成可导入的配置（复制 / 下载），导出按钮只在 `buildConfig` 给出结果时出现；
 *     另有一个「用测试地址填匹配模式」的派生按钮，取来源补 `/*` 并切回通配符；
 * 11. 对比表的整列高亮（CSS 选不出「鼠标所在那一列」）；
 * 12. FAQ 的直达链接：hash 指向某一问时替它展开，悬停/聚焦到那一行则给一枚复制链接的
 *     链形按钮（无 JS 时按钮不出现，深链退化成「滚到那一问，自己点开」）；
 * 13. FAQ 的关键词筛选：按「问题 + 答案」收起不相关的条目与空掉的分类标题，Esc 清空
 *     （无 JS 时整块不出现，问答照旧全部可读、可点、可滚）。
 * 14. 窄屏下对比表的横滑提示：与第 3 项共用同一份「截断在哪一侧」的判据，
 *     只给右缘渐隐——左那一列是钉住的，淡掉它反而读不出比的是哪一家。
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

    /* 键盘翻页。轨道本来就写着 `tabindex="0"`，浏览器也允许用方向键推一个可滚动区域，
       但那套原生滚动既不挪圆点（`mark()` 只由相交检测补，慢半拍）、也不重置自动轮播的计时，
       按一下滚出半张图，上一张和下一张各露一半。这里按「一格一张」接管，走的是与点击
       同一出口（`show`），所以圆点、暂停、续播三件事一起对。
       只认这四个键：上下与 PageUp/PageDown 留给页面自己的纵向滚动，修饰键组合一律放行。 */
    track.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: slides.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      show(target, true);
    });

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

  /* ─────────────── 3. 锚点条：横向滚动与当前区块高亮 ─────────────── */

  /**
   * 横向溢出容器的「这边还有」判据：把截断发生在哪一侧写进 `data-edge`，
   * 样式那一侧负责渐隐。页头锚点条与窄屏下的对比表共用这一份——
   * 两处说的是同一件事，写成两份就总有一天只有一处会淡。
   * 只在值真的变了时才写属性：这个函数挂在滚动与 resize 上，无谓的写入会让样式反复失效。
   */
  const syncEdge = el => {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) {
      if (el.hasAttribute('data-edge')) el.removeAttribute('data-edge');
      return;
    }
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft >= max - 1;
    const edge = atStart ? 'start' : atEnd ? 'end' : 'both';
    if (el.getAttribute('data-edge') !== edge) el.setAttribute('data-edge', edge);
  };

  /**
   * 挂上滚动、窗口缩放与字体落地三程重判，返回手动重判的那一句。
   * 字体落地前量到的是后备字体的宽度，换上去之后才可能溢出（或反过来）。
   * 没有 `document.fonts` 的老引擎就只靠前两程。
   */
  const watchOverflow = el => {
    if (!el) return () => {};
    const run = () => syncEdge(el);
    run();
    el.addEventListener('scroll', run, { passive: true });
    window.addEventListener('resize', run);
    if (document.fonts && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(run, () => {});
    }
    return run;
  };

  /* 锚点条放不下时是一条横向滚动条（见 landing.css 的 `.site-nav`）。三件事都在这里：
     溢出/截断在哪一侧的判据、把高亮项滚进视野、竖滚轮转横滚。三者都只读写
     `data-edge` 与 `scrollLeft`，不碰正文的滚动位置。 */
  const navStrip = document.querySelector('.site-nav');
  watchOverflow(navStrip);

  if (navStrip) {
    /* 竖滚轮在锚点条上转成横滚，但只在它真的还能往那一头走时接管：
       到头之后仍然 `preventDefault` 的话，读者把指针停在页头上就再也滚不动页面。 */
    navStrip.addEventListener(
      'wheel',
      event => {
        const max = navStrip.scrollWidth - navStrip.clientWidth;
        if (max <= 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? navStrip.clientWidth : 1;
        const next = Math.min(max, Math.max(0, navStrip.scrollLeft + event.deltaY * unit));
        if (next === navStrip.scrollLeft) return;
        event.preventDefault();
        navStrip.scrollLeft = next;
      },
      { passive: false },
    );
  }

  /**
   * 把高亮的那一项滚进锚点条的视野；已经在里面就一动不动。
   * 滚动方式沿用 `scrollBehavior()`，减弱动效时同样是瞬时。
   * @param {Element | undefined} link 刚拿到 `aria-current` 的那一项
   */
  const revealNavLink = link => {
    if (!navStrip || !link || !link.closest('.site-nav')) return;
    const box = navStrip.getBoundingClientRect();
    const rect = link.getBoundingClientRect();
    const margin = 14;
    if (rect.left < box.left + margin) {
      navStrip.scrollTo({
        left: navStrip.scrollLeft + rect.left - box.left - margin,
        behavior: scrollBehavior(),
      });
    } else if (rect.right > box.right - margin) {
      navStrip.scrollTo({
        left: navStrip.scrollLeft + rect.right - box.right + margin,
        behavior: scrollBehavior(),
      });
    }
  };

  /* 同一批锚点在页面上存在两簇：桌面横条 `.site-nav` 与 ≤760px 的汉堡面板
     `.nav-menu-panel`。只查前者的话，窄屏下可见的那一簇永远拿不到 `aria-current`，
     选中态等于没有——所以两簇一起收，按 id 存成「一个区块对应多份链接」。
     两簇除了同 id 还要同序，且这个顺序必须等于正文小节自上而下的顺序：菜单是滚动的
     目录，不是「动作项收尾」的排版偏好（2026-09-27 中英两页把「安装」与「常见问题」
     调了个位，正文里 #install 本来就在 #faq 之前）。下面按 DOM 现算高亮、不认顺序，
     顺序排反了没有任何测试会红，只有读者会在读完最后一节后被拽回上面一节——改菜单或
     挪小节位置时，中英两页 × 两簇共四处要一起对。 */
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
          const current = linksById.get(entry.target.id) || [];
          current.forEach(a => a.setAttribute('aria-current', 'true'));
          revealNavLink(current.find(a => a.closest('.site-nav')));
        });
      },
      { rootMargin: '-72px 0px -62% 0px', threshold: 0 },
    );
    sections.forEach(section => navObserver.observe(section));
  }

  /* ─────────────── 4. 小屏汉堡菜单：展开状态与三种收起方式 ─────────────── */

  const navMenu = document.querySelector('.nav-menu');

  if (navMenu) {
    const summary = navMenu.querySelector('summary');

    /* `<details>` 的开合状态辅助技术读得到，但面板现在带进场动画，
       显式声明 `aria-expanded` 让「按钮控制的是哪块内容」说得更清楚。 */
    const syncExpanded = () => {
      if (summary) summary.setAttribute('aria-expanded', String(navMenu.open));
    };

    /* 收起后焦点要有个去处：面板一 `display: none`，停在面板里的焦点就落回 body，
       键盘用户得从头 Tab 一遍才回到菜单按钮。Esc 这一路把焦点交还给 summary。 */
    const closeMenu = ({ restoreFocus = false } = {}) => {
      if (!navMenu.open) return;
      navMenu.removeAttribute('open');
      if (restoreFocus && summary) summary.focus();
    };

    navMenu.addEventListener('toggle', syncExpanded);
    navMenu.addEventListener('click', event => {
      if (event.target.closest('a')) closeMenu();
    });

    /* 点面板之外即收起。触屏上「点空白处」是比「再点一次那颗按钮」更常见的期待，
       而 `<details>` 原生只认 summary。判据是 `contains(event.target)`：
       面板内边距上那几像素仍算面板，点到那里不收——把那一层也当「外面」，
       贴着边缘的点击就会被读成误触。 */
    document.addEventListener('pointerdown', event => {
      if (!navMenu.open) return;
      if (navMenu.contains(event.target)) return;
      closeMenu();
    });

    /* Esc 收起并把焦点送回按钮。只认这棵树自己的 keydown，
       FAQ 那些 `<details>` 不归这里管，别顺手替它们关。 */
    navMenu.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      closeMenu({ restoreFocus: true });
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

  /* ─────────────── 6. 一键复制（微信号与预演面板共用） ─────────────── */

  /**
   * 兜底路径：非安全上下文与旧浏览器只有 execCommand 能写剪贴板，用完即删。
   * @param {string} text 要写入的文本
   * @returns {boolean} execCommand 是否报告成功
   */
  const legacyCopy = text => {
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

  /**
   * 把一段文本写进剪贴板，失败不抛。
   * @param {string} text 要写入的文本
   * @returns {Promise<boolean>} 是否真的写进去了
   */
  const copyText = async text => {
    if (!text) return false;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // 权限或焦点受限时 writeText 会 reject，落到下面的 execCommand 兜底
      }
    }
    return copied || legacyCopy(text);
  };

  /**
   * 在一块 `role="status"` 区域里播报一次结果，4 秒后收回。
   * 按钮文字变化不一定会被辅助技术播报，这个区域会。
   * @param {Element|null} status 播报区域
   * @returns {(message: string, ok: boolean) => void} 播报函数
   */
  const statusReporter = status => {
    let timer = null;
    return (message, ok) => {
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
  };

  all('[data-copy], [data-copy-from]').forEach(btn => {
    const okMsg = btn.getAttribute('data-copied') || 'Copied';
    const errMsg = btn.getAttribute('data-copy-failed') || 'Copy failed';
    const status = btn.parentElement ? btn.parentElement.querySelector('.copy-status') : null;
    const report = statusReporter(status);
    const label = btn.querySelector('.code-copy-text');
    const idleLabel = label ? label.textContent : '';
    let resetTimer = null;

    btn.addEventListener('click', async () => {
      const literal = btn.getAttribute('data-copy');
      // `data-copy-from` 让按钮从同一个 .code-shell 里的 <code> 现读文本：
      // 命令只在 HTML 写一份，按钮不再存第二份，改命令时不会漏改一处。
      const shell = literal ? null : btn.closest('.code-shell');
      const code = shell ? shell.querySelector('code') : null;
      const text = literal || (code ? code.textContent.replace(/\s+$/, '') : '');
      if (!text) return;
      const copied = await copyText(text);
      report(copied ? okMsg : errMsg, copied);
      if (!label) return;
      // 提示区是给辅助技术的，按钮才是视线里的那个：两处都换，成功时再补一下形。
      label.textContent = copied ? okMsg : errMsg;
      btn.classList.toggle('is-copied', copied);
      btn.classList.toggle('is-failed', !copied);
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        label.textContent = idleLabel;
        btn.classList.remove('is-copied', 'is-failed');
        resetTimer = null;
      }, 2000);
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

  /* ─────────────── 8. 首屏循环动效：滚进视口才巡航 ─────────────── */

  /**
   * 循环动效的入视闸门。样式侧在 `html.js` 之下先 `animation-play-state: paused`，
   * 由这里加上 `.is-live` 才放行——循环动效在视口外照样逐帧跑，不该这么耗电。
   * 观察器无条件建：减弱动效下不放行（那种偏好下画不出巡航），但偏好中途翻回来时
   * 当场就能续上——样式那半的媒体查询只负责「关」，帮不上「重新开」。
   *
   * @param {Element | null} target 承载 `.is-live` 的元素，找不到就整段不绑定
   */
  const cruiseWhenVisible = target => {
    if (!target) return;

    let inView = false;
    const syncLive = () => target.classList.toggle('is-live', inView && !reduceMotion());

    // 偏好回调两条分支都要登记：这句必须排在下面的分支判断**之前**——早 `return` 会让
    // 「没有 IntersectionObserver」那半永远收不到它，于是那句 JSDoc 承诺的「偏好中途翻回来
    // 时当场就能续上」在那种运行时不成立（样式那半的媒体查询只负责「关」，帮不上「重新开」）。
    onMotionChange(syncLive);

    if (!('IntersectionObserver' in window)) {
      inView = true;
      syncLive();
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          inView = entry.isIntersecting;
          syncLive();
        });
      },
      { threshold: 0.3 },
    );
    observer.observe(target);
  };

  /* 流程图（页面 → 通道 → 目标环境）与它下面那条 CORS 两态各自入账：
     两叠卡片的可见度不一样，共用一个闸门会让半截动画在没人看的时候照跑。 */
  cruiseWhenVisible(document.querySelector('.hero-visual .flow'));
  cruiseWhenVisible(document.querySelector('.hero-outcome'));

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
    const takeBox = tryBlock.querySelector('[data-try-take]');
    const copyButton = tryBlock.querySelector('[data-try-copy]');
    const downloadButton = tryBlock.querySelector('[data-try-download]');
    const fillButton = tryBlock.querySelector('[data-try-fill]');
    const reportTake = statusReporter(tryBlock.querySelector('[data-try-status]'));
    const reportFill = statusReporter(tryBlock.querySelector('[data-try-fill-status]'));

    /** 当前这份输入能导出的配置；`null` 时「带走」那一块整个不出现。 */
    let currentConfig = null;

    const fieldOf = key => fields.find(([name]) => name === key)?.[1] || null;

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

      /* 「带走」的闸门就是引擎自己的 `buildConfig`：没命中、模式被拒、网络层算不出可跳转地址，
         它都回 `null`，这一块连同两个按钮一起消失——页面上不存在一条没预演过的配置。 */
      currentConfig = engine.buildConfig({ ...input, matchType: input.matchType || 'wildcard' }, { now: Date.now() });
      if (takeBox) takeBox.hidden = !currentConfig;
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

    /* 「用测试地址填匹配模式」：派生判据在引擎里（`patternFromUrl`），这里只搬运结果。
       派生出来的一定是「来源/*」，所以匹配类型一并切回通配符——留着正则只会让刚填好的模式
       被当成一段正则去编译。失败时不改任何输入，只把原因写进状态区。 */
    if (fillButton) {
      fillButton.addEventListener('click', () => {
        const urlField = fieldOf('url');
        const derived = engine.patternFromUrl(urlField ? urlField.value : '');
        if (!derived) {
          reportFill(fillButton.getAttribute('data-fill-failed') || 'Fill in an address first', false);
          return;
        }
        const typeField = fieldOf('matchType');
        const patternField = fieldOf('pattern');
        if (typeField) typeField.value = 'wildcard';
        if (patternField) {
          patternField.value = derived;
          /* 一次性高亮：告诉读者「改的是这一格」，不循环、不位移。减弱动效下 CSS 已经把
             `animation` 关掉，但 `animationend` 也就不会来——这时连类名和监听器都不挂，
             省得每次点击积一个永远等不到事件的监听器。 */
          if (!reduceMotionQuery.matches) {
            patternField.classList.remove('is-filled');
            void patternField.offsetWidth;
            patternField.classList.add('is-filled');
            patternField.addEventListener('animationend', () => patternField.classList.remove('is-filled'), {
              once: true,
            });
          }
        }
        render();
        reportFill(fillButton.getAttribute('data-filled') || 'Pattern filled', true);
      });
    }

    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        if (!currentConfig) return;
        const copied = await copyText(JSON.stringify(currentConfig, null, 2));
        reportTake(
          copied
            ? copyButton.getAttribute('data-copied') || 'Copied'
            : copyButton.getAttribute('data-copy-failed') || 'Copy failed',
          copied,
        );
      });
    }

    if (downloadButton) {
      downloadButton.addEventListener('click', () => {
        if (!currentConfig) return;
        const blob = new Blob([JSON.stringify(currentConfig, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = downloadButton.getAttribute('data-filename') || 'cross-origin-proxy-rule.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        /* 立刻 revoke 会让部分浏览器来不及取走数据，交回事件循环再收。 */
        setTimeout(() => URL.revokeObjectURL(href), 0);
        reportTake(downloadButton.getAttribute('data-downloaded') || 'Downloaded', true);
      });
    }

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

    /* 「本扩展」那一列第一次进视野时刷一次主色（样式见 landing.css 的 `lp-col-flag`）。
       判据是相交而不是页面加载：这张表在文档中段，加载时播完一轮，读者滚过来看到的
       仍是那层常亮底色，等于没做。`disconnect()` 就是「只此一次」的实现——
       离开再回来不重播，反复刷就成了广告。
       没有 IntersectionObserver 的运行时不加类：那一圈是纯装饰，没有一格的可读性挂在它上面。 */
    if ('IntersectionObserver' in window) {
      const flag = new IntersectionObserver(
        entries => {
          if (!entries.some(entry => entry.isIntersecting)) return;
          table.classList.add('us-flagged');
          flag.disconnect();
        },
        { threshold: 0.35 },
      );

      flag.observe(table);
    }
  });

  /* ─────────────── 12. FAQ 直达链接：按 hash 展开、复制链接 ─────────────── */

  /* 每一问都有自己的 id（`#faq-basics-3`，样式见 landing.css 的 `.faq-permalink`），
     于是两件事成立：
     ① 从搜索结果、AI 回答或同事的消息里点进来，那一问是**展开的**——不这么做，深链落在
        一条折叠着的问题上，读者还得再点一次才知道链接给对了没有；
     ② 悬停或键盘走到那一行时出现一枚链形按钮，点它把这一问的直达地址写进剪贴板。
     禁用 JS 时这一枚由 CSS 藏起来，深链退化成「滚到那一问，自己点开」，内容一个字不少。 */
  const faqLinks = all('.faq-permalink');

  if (faqLinks.length) {
    /** 展开 hash 指向的那条 `<details>`；指向别处（小节标题、分类）就什么都不做。 */
    const openFromHash = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target || target.tagName !== 'DETAILS' || target.open) return;
      /* 只展开，不跟着滚：落点交给浏览器自己那一次「滚到锚点」，样式里的
         `scroll-margin-top: 88px` 负责躲开 62px 的吸顶页头（真机 A/B：带着那条停在
         距顶 88px，摘掉停在 0px，正好压在页头底下）。
         这边再补一次 `scrollIntoView` 实测是多余的接手——摘掉它，26 项真机读数逐位不变，
         而两份「谁说了算」的判据留着，将来改一处忘一处就是下一次的位置错乱。
         顺带记一笔：`behavior` 写 `'auto'` 不是「瞬时」，它会去跟随
         `html { scroll-behavior: smooth }`，那种写法接手到的也是一段动画。 */
      target.open = true;
    };

    window.addEventListener('hashchange', openFromHash);
    openFromHash();

    faqLinks.forEach(link => {
      const item = link.closest('details');
      if (!item || !item.id) return;
      /* 播报区只建一次、之后清空复用：现插一个带字的 `role="status"` 节点，
         辅助技术未必来得及把它当活的区域；留着它，第二次起就是明确的文字变更。 */
      let status = null;
      let timer = null;

      link.addEventListener('click', async event => {
        /* 这颗按钮长在 `<summary>` 里：不拦 default，点它顺手就把这一条开合了，
           读者只会以为链接没生效。跳转也一并接管——下面自己改地址栏，不靠原生那一次。 */
        event.preventDefault();
        const url = `${location.href.split('#')[0]}#${item.id}`;
        item.open = true;
        /* 地址栏跟着走，读者看得见自己刚复制出去的是什么。用 replaceState 而不是
           直接改 `location.hash`：后者会触发 hashchange，那一轮又要滚一次。 */
        if (location.hash !== `#${item.id}`) history.replaceState(null, '', `#${item.id}`);
        const copied = await copyText(url);

        if (!status) {
          status = document.createElement('span');
          status.className = 'faq-copy-status';
          status.setAttribute('role', 'status');
          link.insertAdjacentElement('afterend', status);
        }
        status.textContent = copied
          ? link.getAttribute('data-copy-ok') || 'Copied'
          : link.getAttribute('data-copy-fail') || 'Copy failed';
        status.classList.toggle('is-failed', !copied);
        link.classList.toggle('is-copied', copied);
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          status.textContent = '';
          link.classList.remove('is-copied');
          timer = null;
        }, 2600);
      });
    });
  }

  /* ─────────────── 13. FAQ 关键词筛选 ─────────────── */

  /* 21 问分五类，滚着找不如打字找。可搜的是「问题 + 答案」整段——很多词只出现在答案里
     （`declarativeNetRequest`、`credentials: 'include'`），只搜标题的话读者会以为没答案。
     隐藏走 `hidden` 属性而不是删节点：文档顺序、条目数与 `FAQPage` 的一致性守卫读的都是
     源码里的这一份，运行时怎么筛不该动到它们，也不该动到「第 3 问是 #faq-basics-3」这件事。 */
  const faqFilter = document.querySelector('.faq-filter-input');

  if (faqFilter) {
    const list = faqFilter.closest('.faq-list');
    const status = document.getElementById('faq-filter-status');
    const items = list ? Array.from(list.querySelectorAll('details[id]')) : [];
    const headings = list ? Array.from(list.querySelectorAll('.faq-category')) : [];
    /* 一次算好每条的可搜文本：每次击键都重读 21 条 `textContent` 是没必要的重复劳动。
       那枚 permalink 没有文字节点（只有一张 SVG），所以它不会往这里掺进「复制」之类的字。 */
    const haystacks = items.map(item => (item.textContent || '').toLowerCase().replace(/\s+/g, ' '));
    const template = (status && status.getAttribute('data-count')) || '{n}/{total}';
    const emptyMessage = (status && status.getAttribute('data-empty')) || '';
    const total = items.length;

    const apply = () => {
      const query = faqFilter.value.trim().toLowerCase();
      let shown = 0;
      items.forEach((item, index) => {
        const hit = !query || haystacks[index].indexOf(query) >= 0;
        item.hidden = !hit;
        if (hit) shown += 1;
      });
      /* 整类都被筛掉时把分类标题也收起来：留着一个底下空空的标题，
         读起来像「这一节一条都没有」，而它只是被筛掉了。 */
      headings.forEach(heading => {
        let node = heading.nextElementSibling;
        let anyVisible = false;
        while (node && !node.classList.contains('faq-category')) {
          if (node.tagName === 'DETAILS' && !node.hidden) {
            anyVisible = true;
            break;
          }
          node = node.nextElementSibling;
        }
        heading.hidden = !anyVisible;
      });
      /* 零命中是这一节最容易走人的那一刻：出口就摆在失败发生的地方，
         而不是让读者自己往下滚去找「没找到答案？」那张卡。
         这里只切一个类——措辞与去处全在 HTML（落地页有页内 #community，
         对比页只有仓库 issue，两页本来就不一样）。 */
      const none = list.querySelector('.faq-filter-none');
      if (none) none.classList.toggle('is-shown', shown === 0);
      if (!status) return;
      if (!query) {
        status.textContent = '';
        return;
      }
      status.textContent = shown
        ? template.replace('{n}', String(shown)).replace('{total}', String(total))
        : emptyMessage;
    };

    faqFilter.addEventListener('input', apply);
    /* Esc 清空并交还焦点归位（浏览器对 `type=search` 的默认行为就是 Esc 清空，
       但只有它有值时我们才接管，免得把「关掉某个还没做的东西」也一起吞掉）。 */
    faqFilter.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !faqFilter.value) return;
      event.preventDefault();
      faqFilter.value = '';
      apply();
    });

    /* 筛掉的那一条正好是被链的那一问时，筛选让位于深链：点了链接就是要看它，不该被自己
       三秒前打的字挡住。而且这一格脚本**必须**负责滚——那一问在被筛掉的状态下没有盒子，
       浏览器那一次「滚到锚点」滚了个空（真机量到：筛掉、展开都对，位置停在原地，
       那一问距顶 1691px）。与第 12 段不冲突：那条针对「元素本来就在页面上」的初次导航，
       这里针对「元素刚刚才从 display:none 里出来」。
       右侧那栏「分类直达」同一条规则：整类被筛空时它的标题也收着，点它就是要点它。 */
    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target || !target.hidden) return;
      if (target.tagName !== 'DETAILS' && !target.classList.contains('faq-category')) return;
      faqFilter.value = '';
      apply();
      target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    });
  }

  /* ─────────────── 14. 窄屏下的对比表：横滑的那一侧给个信号 ─────────────── */

  /* 390px 视口实测：这张 7 列的表要横滑 228px（中文页）到 413px（英文页）才看得完，
     而它此前没有任何「这边还有」的信号——页头锚点条上一轮补了方向感知的渐隐，
     这张表是同一件事漏掉的那一格。判据与锚点条共用 `watchOverflow`，
     样式只给**右缘**渐隐：左缘那一列是钉住的（`.compare thead th:first-child`），
     把钉住的那列淡掉反而读不出比的是哪一家。滚到最右时 `data-edge` 变成 `end`，渐隐自己退场。 */
  document.querySelectorAll('.table-scroll').forEach(shell => {
    if (shell.querySelector('table')) watchOverflow(shell);
  });
})();
