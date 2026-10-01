/* =========================================================================
   МАРШРУТ «СИНЯЯ РУКА» — логика приложения
   Ванильный JS, без сборки и без бэкенда. Один живой маршрут, три режима
   входа (Observation / Journey / Immersion), локальное время по Москве.
   ========================================================================= */
(function () {
  "use strict";

  var CFG = window.BH_CONFIG;
  var POINTS = window.BH_POINTS;
  var DAYS = window.BH_DAYS;

  var LS = {
    INTRO_SEEN: "bh_intro_seen",
    MODE: "bh_mode",
    DAY_ENTERED_PREFIX: "bh_day_entered_", // + dayIndex -> "YYYY-MM-DD" (moscow calendar date when first entered)
    FINALE_PLAYED: "bh_finale_played", // "YYYY-MM-DD" of the moscow date it was completed, once
    PRACTICE_CHOICE_PREFIX: "bh_practice_choice_day_" // + dayIndex -> "A" | "B"
  };

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore (private mode etc.) */ }
  }

  /* ----------------------------- Яндекс.Метрика: цели -----------------------------
     Тонкая безопасная обёртка: если счётчик по какой-то причине не загрузился
     (блокировщик рекламы, офлайн и т.п.), приложение не должно падать —
     вызов просто ничего не делает. */
  var YM_COUNTER_ID = 112912042;
  function trackGoal(name, params) {
    try {
      if (typeof window.ym === "function") {
        window.ym(YM_COUNTER_ID, "reachGoal", name, params || {});
      }
    } catch (e) { /* аналитика не должна ломать маршрут */ }
  }

  /* ----------------------------- Время по Москве ----------------------------- */

  // Позволяет тестировать разные даты без изменения системных часов:
  // ?debugNow=2026-09-25T10:00:00 в адресной строке.
  function getNow() {
    var params = new URLSearchParams(window.location.search);
    var dbg = params.get("debugNow");
    if (dbg) {
      var d = new Date(dbg);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  function getMoscowParts(date) {
    var fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: CFG.timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });
    var parts = fmt.formatToParts(date);
    var map = {};
    parts.forEach(function (p) { map[p.type] = p.value; });
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hour: parseInt(map.hour === "24" ? "0" : map.hour, 10),
      minute: parseInt(map.minute, 10),
      second: parseInt(map.second, 10)
    };
  }

  function dateKey(parts) {
    return parts.year + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
  }

  function calendarUTC(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day);
  }

  function computeRouteState() {
    var now = getNow();
    var parts = getMoscowParts(now);
    var todayUTC = calendarUTC(parts);
    var startUTC = Date.UTC(CFG.startDate.year, CFG.startDate.month - 1, CFG.startDate.day);
    var dayIndex = Math.round((todayUTC - startUTC) / 86400000) + 1;

    var phase, currentDay = null;
    if (dayIndex < 1) {
      phase = "waiting";
    } else if (dayIndex <= CFG.totalDays) {
      phase = "active";
      currentDay = dayIndex;
    } else {
      phase = "finished";
    }
    return {
      phase: phase,
      currentDay: currentDay,
      todayKey: dateKey(parts),
      now: now
    };
  }

  /* ----------------------------- Режим входа ----------------------------- */

  var MODE_LABELS = {
    observation: "Наблюдение",
    journey: "Путешествие",
    immersion: "Погружение"
  };

  function detectMode() {
    var path = window.location.pathname.toLowerCase().replace(/\/+$/, "");
    var params = new URLSearchParams(window.location.search);
    var qMode = (params.get("mode") || "").toLowerCase();

    var fromPath = null;
    if (/(^|\/)(nablyudenie|observation)$/.test(path)) fromPath = "observation";
    else if (/(^|\/)(puteshestvie|journey)$/.test(path)) fromPath = "journey";
    else if (/(^|\/)(pogruzhenie|immersion)$/.test(path)) fromPath = "immersion";

    var fromQuery = null;
    if (qMode === "observation" || qMode === "nablyudenie") fromQuery = "observation";
    else if (qMode === "journey" || qMode === "puteshestvie") fromQuery = "journey";
    else if (qMode === "immersion" || qMode === "pogruzhenie") fromQuery = "immersion";

    var resolved = fromPath || fromQuery;
    if (resolved) {
      lsSet(LS.MODE, resolved);
      return resolved;
    }
    var stored = lsGet(LS.MODE);
    if (stored === "observation" || stored === "journey" || stored === "immersion") return stored;
    return "observation";
  }

  /* ----------------------------- DOM helpers ----------------------------- */

  var screens = {};
  function showScreen(name) {
    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle("is-visible", k === name);
    });
    // На финале свой золотой логотип (.finale-logo) — деликатный синий
    // водяной знак (.brand-mark) там прячем, чтобы не дублировать бренд.
    document.body.classList.toggle("bh-hide-watermark", name === "finale");
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ----------------------------- Мини-markdown для текстов дня -----------------------------
     Поддерживает: абзацы (пустая строка), списки "- " и "1. ", **bold** внутри строк.
     Ничего не сокращает и не переписывает — только превращает уже имеющуюся в исходном
     тексте разметку в семантичный HTML (см. ТЗ, раздел 13). */
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineMd(s) {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
  function renderRich(md, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();
    if (!md) return frag;
    var blocks = md.trim().split(/\n\s*\n/);
    blocks.forEach(function (blockRaw) {
      var block = blockRaw.trim();
      if (!block) return;
      var lines = block.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var isUl = lines.length > 0 && lines.every(function (l) { return /^-\s+/.test(l); });
      var isOl = lines.length > 0 && lines.every(function (l) { return /^\d+\.\s+/.test(l); });
      if (isUl) {
        var ul = el("ul", "rich-list");
        lines.forEach(function (l) {
          var li = document.createElement("li");
          li.innerHTML = inlineMd(l.replace(/^-\s+/, ""));
          ul.appendChild(li);
        });
        frag.appendChild(ul);
      } else if (isOl) {
        var ol = el("ol", "rich-list");
        lines.forEach(function (l) {
          var li = document.createElement("li");
          li.innerHTML = inlineMd(l.replace(/^\d+\.\s+/, ""));
          ol.appendChild(li);
        });
        frag.appendChild(ol);
      } else {
        var p = document.createElement("p");
        if (opts.emphasize) p.className = "rich-emphasis";
        p.innerHTML = lines.map(inlineMd).join("<br>");
        frag.appendChild(p);
      }
    });
    return frag;
  }

  /* ----------------------------- Приложение ----------------------------- */

  var App = {
    mode: null,
    state: null,
    dayCardOpenDay: null,

    init: function () {
      screens.intro = document.getElementById("screen-intro");
      screens.waiting = document.getElementById("screen-waiting");
      screens.scene = document.getElementById("screen-scene");
      screens.day = document.getElementById("screen-day");
      screens.finale = document.getElementById("screen-finale");

      this.mode = detectMode();
      this.state = computeRouteState();

      trackGoal("mode_" + this.mode);

      this.renderIntroScreen();
      this.renderWaitingScreen();

      var introSeen = lsGet(LS.INTRO_SEEN) === "1";
      if (!introSeen) {
        showScreen("intro");
      } else {
        this.renderCurrentState();
      }

      this.renderBrandWatermark();

      // Периодическая проверка смены дня/фазы (полночь по Москве и т.п.)
      var self = this;
      setInterval(function () { self.tick(); }, 30000);
    },

    tick: function () {
      var fresh = computeRouteState();
      var changed = !this.state ||
        fresh.phase !== this.state.phase ||
        fresh.currentDay !== this.state.currentDay;
      this.state = fresh;
      if (changed && lsGet(LS.INTRO_SEEN) === "1") {
        // Смена дня строго в 00:00 МСК: если в этот момент открыта карта
        // старого дня — закрываем её, чтобы она не осталась поверх новой сцены.
        if (screens.day && screens.day.classList.contains("is-visible")) {
          this.closeDayCard();
        }
        this.renderCurrentState();
      }
    },

    renderCurrentState: function () {
      if (this.state.phase === "waiting") {
        showScreen("waiting");
      } else if (this.state.phase === "finished") {
        this.showCompletedFinale();
      } else {
        this.renderScene();
        showScreen("scene");
      }
    },

    /* ---------------- Деликатный водяной знак 13 MIRRORS (раздел 4 ТЗ) ----------------
       Один фиксированный элемент на всё приложение — показывается поверх сцены и
       карточки дня, прячется на финале (там свой золотой логотип, см. finale-logo). */
    renderBrandWatermark: function () {
      var mark = el("div", "brand-mark");
      var img = el("img", null);
      img.src = "assets/logo_watermark.png";
      img.alt = "13 MIRRORS";
      mark.appendChild(img);
      document.getElementById("app").appendChild(mark);
    },

    /* ---------------- INTRO ----------------
       Раздел 9 ТЗ: картинка сверху, текст — отдельно, на плотной тёмно-синей
       подложке снизу. Не раскладываем текст поверх сложной картинки —
       так он остаётся читаемым при любой длине. */
    renderIntroScreen: function () {
      var root = screens.intro;
      root.innerHTML = "";
      root.classList.add("screen-intro-layout");

      var wrap = el("div", "intro-wrap");

      var imageBox = el("div", "intro-image");
      var img = el("img", null);
      img.src = "assets/intro_panorama.webp";
      img.alt = "";
      imageBox.appendChild(img);
      wrap.appendChild(imageBox);

      var panel = el("div", "intro-panel");

      var introMd = (window.BH_INTRO_TEXT || "").trim();
      var lines = introMd
        .split("\n")
        .filter(function (l) { return l.trim().length && !/^\*\*Кнопка/i.test(l.trim()); })
        .map(function (l) { return l.replace(/\*\*/g, "").trim(); });

      lines.forEach(function (line) {
        panel.appendChild(el("p", null, line));
      });

      var btn = el("button", "btn primary", "Войти в маршрут");
      btn.addEventListener("click", function () {
        lsSet(LS.INTRO_SEEN, "1");
        App.state = computeRouteState();
        App.renderCurrentState();
      });
      panel.appendChild(btn);

      wrap.appendChild(panel);
      root.appendChild(wrap);
    },

    /* ---------------- WAITING ---------------- */
    renderWaitingScreen: function () {
      var root = screens.waiting;
      root.innerHTML = "";
      var bg = el("img", "screen-bg");
      bg.src = "assets/hands_master.jpg";
      bg.alt = "";
      var veil = el("div", "screen-veil");
      var content = el("div", "screen-content");
      content.appendChild(el("h1", null, CFG.waitingText));
      content.appendChild(el("p", "dim", "Маршрут «Синяя Рука» · 13 дней"));
      root.appendChild(bg);
      root.appendChild(veil);
      root.appendChild(content);
    },

    /* ---------------- MAIN SCENE ---------------- */
    getDayState: function (dayNumber) {
      var current = this.state.currentDay;
      if (dayNumber > current) return "future";
      if (dayNumber < current) return "past";
      // dayNumber === current
      var enteredKey = lsGet(LS.DAY_ENTERED_PREFIX + dayNumber);
      if (enteredKey === this.state.todayKey) return "active";
      return "idle";
    },

    renderScene: function () {
      var root = screens.scene;
      root.innerHTML = "";

      var wrap = el("div", "scene-wrap");
      var bg = el("img", null);
      bg.src = "assets/hands_master.jpg";
      bg.alt = "Маршрут Синяя Рука";
      wrap.appendChild(bg);

      // Раздел 3 ТЗ: только номер дня (между звёзд, верх сцены) и тихая
      // подпись режима внизу слева — без плашки "День X из 13 · Формат".
      var dayNum = el("div", "scene-daynum", String(this.state.currentDay));
      wrap.appendChild(dayNum);

      var modeLabel = el("div", "scene-mode-label", "Формат: " + MODE_LABELS[this.mode]);
      wrap.appendChild(modeLabel);

      var sparkLayer = el("div", "spark-layer");
      wrap.appendChild(sparkLayer);
      this._sparkLayer = sparkLayer;
      this._sceneWrap = wrap;

      for (var i = 1; i <= 13; i++) {
        var p = POINTS[i];
        var dayState = this.getDayState(i);
        // День 7 и 13 — центральные узлы (мост между ладонями), для них
        // активная зона держится крупнее, чтобы не приходилось её искать (раздел 6 ТЗ).
        var isCentral = (i === 7 || i === 13);
        var btn = el("button", "hotspot state-" + dayState + (isCentral ? " hotspot-central" : ""));
        btn.style.left = p.x + "%";
        btn.style.top = p.y + "%";
        btn.setAttribute("data-day", i);
        btn.setAttribute("aria-label", "День " + i);
        // halo — усиление уже существующего светового узла картинки (раздел 5 ТЗ);
        // dot — маленькое яркое ядро поверх него, без отдельного жёлтого кружка.
        var halo = el("span", "halo");
        var dot = el("span", "dot");
        btn.appendChild(halo);
        btn.appendChild(dot);
        if (dayState === "idle" || dayState === "active") {
          btn.addEventListener("click", this.onDayNodeClick.bind(this, i));
        } else {
          btn.disabled = true;
        }
        wrap.appendChild(btn);
      }

      root.appendChild(wrap);
    },

    onDayNodeClick: function (dayNumber) {
      if (this._animating) return;
      var p = POINTS[dayNumber];
      var target = POINTS[p.target] || p;
      this._animating = true;
      this.playEntryAnimation(p, target, function () {
        lsSet(LS.DAY_ENTERED_PREFIX + dayNumber, App.state.todayKey);
        App.openDayCard(dayNumber);
        App._animating = false;
        // обновим точку на состояние "active" под карточкой
        var wrap = App._sceneWrap;
        if (wrap) {
          var hs = wrap.querySelector('.hotspot[data-day="' + dayNumber + '"]');
          if (hs) {
            var central = (dayNumber === 7 || dayNumber === 13) ? " hotspot-central" : "";
            hs.className = "hotspot state-active" + central;
          }
        }
      });
    },

    playEntryAnimation: function (from, to, done) {
      var wrap = this._sceneWrap;
      var layer = this._sparkLayer;
      layer.innerHTML = "";

      var rect = wrap.getBoundingClientRect();
      var fx = (from.x / 100) * rect.width;
      var fy = (from.y / 100) * rect.height;
      var tx = (to.x / 100) * rect.width;
      var ty = (to.y / 100) * rect.height;
      var sameSpot = Math.abs(fx - tx) < 2 && Math.abs(fy - ty) < 2;

      // burst at origin node
      var originBurst = el("div", "spark-burst");
      originBurst.style.left = fx + "px";
      originBurst.style.top = fy + "px";
      layer.appendChild(originBurst);
      requestAnimationFrame(function () {
        originBurst.style.transition = "opacity 0.35s ease, transform 0.5s ease";
        originBurst.style.opacity = "1";
        originBurst.style.transform = "scale(1)";
      });

      var totalMs = 2500;

      if (sameSpot) {
        // просто усиливающееся свечение в центре (точки 6/7/13, и День 13 —
        // раздел 22 ТЗ: искорка никуда не улетает)
        setTimeout(function () {
          originBurst.style.opacity = "0";
        }, totalMs - 250);
        setTimeout(function () { layer.innerHTML = ""; }, totalMs + 300);
        setTimeout(done, totalMs);
        return;
      }

      // path: живая волна (S-образная кривая через две контрольные точки в
      // противоположные стороны), а не жёсткая дуга — хотфикс п.5
      var dx = tx - fx, dy = ty - fy;
      // перпендикуляр к линии движения, нормированный
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var wave = Math.min(46, len * 0.16);
      var c1x = fx + dx * 0.32 + nx * wave;
      var c1y = fy + dy * 0.32 + ny * wave;
      var c2x = fx + dx * 0.68 - nx * wave;
      var c2y = fy + dy * 0.68 - ny * wave;
      var pathData = "M " + fx + " " + fy + " C " + c1x + " " + c1y + " " + c2x + " " + c2y + " " + tx + " " + ty;

      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "spark-line");
      svg.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", pathData);
      svg.appendChild(path);
      layer.appendChild(svg);

      var dot = el("div", "spark-dot");
      layer.appendChild(dot);

      requestAnimationFrame(function () {
        path.style.transition = "opacity 0.2s ease";
        path.style.opacity = "0.55"; /* легче, рассеяннее — хотфикс п.5 */
        path.animate(
          [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
          { duration: totalMs * 0.62, delay: 250, fill: "forwards", easing: "ease-in-out" }
        );
      });

      var pathLen = path.getTotalLength ? path.getTotalLength() : null;
      var travelStart = 250;
      var travelDuration = totalMs * 0.62;
      var startTime = null;

      dot.style.opacity = "1";
      dot.style.left = fx + "px";
      dot.style.top = fy + "px";

      function step(ts) {
        if (!startTime) startTime = ts;
        var elapsed = ts - startTime - travelStart;
        if (elapsed < 0) {
          requestAnimationFrame(step);
          return;
        }
        var t = Math.min(1, elapsed / travelDuration);
        var pt;
        if (pathLen) {
          pt = path.getPointAtLength(t * pathLen);
        } else {
          pt = { x: fx + (tx - fx) * t, y: fy + (ty - fy) * t };
        }
        dot.style.left = pt.x + "px";
        dot.style.top = pt.y + "px";
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          // прибытие — усиливаем свечение в целевой точке
          var arrivalBurst = el("div", "spark-burst");
          arrivalBurst.style.left = tx + "px";
          arrivalBurst.style.top = ty + "px";
          arrivalBurst.style.transform = "scale(0.6)";
          arrivalBurst.style.opacity = "1";
          layer.appendChild(arrivalBurst);
          requestAnimationFrame(function () {
            arrivalBurst.style.transition = "opacity 0.6s ease, transform 0.8s ease";
            arrivalBurst.style.transform = "scale(1.6)";
          });
          dot.style.transition = "opacity 0.25s ease";
          dot.style.opacity = "0";

          // Тонкий след искорки постепенно тает и не остаётся на руке
          // толстой постоянной линией (раздел 7 ТЗ).
          path.style.transition = "opacity 0.9s ease";
          path.style.opacity = "0";
        }
      }
      requestAnimationFrame(step);

      setTimeout(function () {
        // полная очистка — ничего не должно остаться поверх сцены
        layer.innerHTML = "";
      }, totalMs + 500);

      setTimeout(done, totalMs);
    },

    /* ---------------- DAY CARD ----------------
       Раздел 8 ТЗ: карта дня — полноэкранная страница со своим обычным
       вертикальным скроллом (не окно-в-окне, без внутреннего scrollbar). */
    openDayCard: function (dayNumber) {
      this.dayCardOpenDay = dayNumber;
      var day = DAYS[dayNumber - 1];
      var card = document.getElementById("day-card");
      card.innerHTML = "";

      trackGoal("day_opened", { day: dayNumber });

      // ---- шапка 16:9, без текста на самой картинке (раздел 10 ТЗ) ----
      var headerImg = el("div", "day-card-header-image");
      var img = el("img", null);
      img.src = day.headerImage;
      img.alt = day.kin;
      headerImg.appendChild(img);
      card.appendChild(headerImg);

      // ---- День / Kin / заголовок ----
      var header = el("div", "day-card-header");
      header.appendChild(el("div", "day-card-eyebrow", "День " + day.day + " · " + day.date));
      header.appendChild(el("h1", null, day.kin));
      card.appendChild(header);

      // ---- Dreamspell-шапка: Печать / Тон ----
      var sPT = el("section");
      var pair = el("div", "pair-block");
      var colSeal = el("div", "col");
      colSeal.appendChild(el("div", "label", "Печать"));
      colSeal.appendChild(el("p", null, day.seal.name));
      colSeal.appendChild(el("p", "dim", day.seal.short));
      var colTone = el("div", "col");
      colTone.appendChild(el("div", "label", "Тон"));
      colTone.appendChild(el("p", null, day.tone.name));
      colTone.appendChild(el("p", "dim", day.tone.short));
      pair.appendChild(colSeal);
      pair.appendChild(colTone);
      sPT.appendChild(pair);
      card.appendChild(sPT);

      // ---- Фокус дня (только для дней 1–12, раздел 11/28 ТЗ) ----
      if (!day.isFinal && day.focus) {
        var sFocus = el("section");
        sFocus.appendChild(el("div", "label", "Фокус дня"));
        sFocus.appendChild(renderRich(day.focus, { emphasize: false }));
        card.appendChild(sFocus);
      }

      if (day.isFinal) {
        this.renderFinalDayCard(card, day);
      } else {
        this.renderRegularDayCard(card, day);
      }

      showScreen("day");
      window.scrollTo(0, 0);
    },

    /* ---- День 13: только вопрос сборки + кнопка "Собрать маршрут" ---- */
    renderFinalDayCard: function (card, day) {
      var sQ = el("section", "day13-question-section");
      var q = el("p", "rich-emphasis");
      q.textContent = day.finalQuestion;
      sQ.appendChild(q);
      card.appendChild(sQ);

      var actions = el("div", "day-card-actions");
      var finalBtn = el("button", "btn primary", day.finalCta);
      finalBtn.addEventListener("click", function () {
        trackGoal("day13_collect_click");
        // Хотфикс п.12: без промежуточного показа сцены рук — сразу в финал,
        // иначе между картой и видео на мгновение мелькают руки.
        App.startDay13Finale();
      });
      actions.appendChild(finalBtn);
      var backBtn = el("button", "btn ghost", "Вернуться в пространство маршрута");
      backBtn.addEventListener("click", function () { App.closeDayCard(); });
      actions.appendChild(backBtn);
      card.appendChild(actions);

      // Предзагрузка финального видео, пока пользователь ещё на карте —
      // к моменту нажатия "Собрать маршрут" оно уже в кэше браузера (хотфикс п.12).
      if (!document.getElementById("bh-video-preload")) {
        var preload = document.createElement("link");
        preload.id = "bh-video-preload";
        preload.rel = "preload";
        preload.as = "video";
        preload.href = "assets/day13_namaste.mp4";
        document.head.appendChild(preload);
      }
    },

    /* ---- Дни 1–12: главный вопрос, закрытый выбор практики A/B (рядом), След ---- */
    renderRegularDayCard: function (card, day) {
      var sQ = el("section", "main-question-section");
      sQ.appendChild(el("div", "label", "Главный вопрос"));
      sQ.appendChild(renderRich(day.mainQuestion, { emphasize: true }));
      card.appendChild(sQ);

      var sPrac = el("section");
      // relative-обёртка — от неё считаются координаты внутренней искорки (раздел 14 ТЗ)
      var practiceStage = el("div", "practice-stage");
      var practiceWrap = el("div", "practice-choice-wrap");
      practiceStage.appendChild(practiceWrap);
      var innerSparkLayer = el("div", "inner-spark-layer");
      practiceStage.appendChild(innerSparkLayer);
      sPrac.appendChild(practiceStage);
      card.appendChild(sPrac);

      // «След дня» — секция видна сразу, заголовок «След дня» служит
      // видимой целью полёта искорки; вопрос и рамка/CTA (traceBody)
      // проявляются только после её прилёта (или сразу — для тех, кто
      // уже выбирал практику раньше).
      var sTrace = el("section", "trace-section");
      var traceHeading = el("h2", "trace-heading", "След дня");
      sTrace.appendChild(traceHeading);
      var traceBody = el("div", "fade-block trace-body");
      sTrace.appendChild(traceBody);
      card.appendChild(sTrace);

      var actions = el("div", "day-card-actions");
      var backBtn = el("button", "btn ghost", "Вернуться в пространство маршрута");
      backBtn.addEventListener("click", function () { App.closeDayCard(); });
      actions.appendChild(backBtn);
      card.appendChild(actions);

      var choiceKey = LS.PRACTICE_CHOICE_PREFIX + day.day;
      var storedChoice = lsGet(choiceKey);

      var self = this;

      // ---- «След дня»: вопрос жёлтым — отдельно над рамкой, в рамке —
      // только режимный блок действия. Сам заголовок «След дня» рисуется
      // отдельно и всегда виден (см. traceHeading выше). ----
      function fillTraceBody() {
        traceBody.innerHTML = "";
        traceBody.appendChild(renderRich(day.traceQuestion, { emphasize: true }));

        var frame = el("div", "trace-frame");
        if (self.mode === "observation") {
          frame.appendChild(el("p", null, "След доступен в формате Путешествие и Погружение."));
        } else if (self.mode === "journey") {
          var linkBtnJ = el("a", "btn link", "Оставить след");
          linkBtnJ.href = CFG.links.journey;
          linkBtnJ.target = "_blank";
          linkBtnJ.rel = "noopener noreferrer";
          linkBtnJ.addEventListener("click", function () {
            trackGoal("trace_link_click", { day: day.day, mode: self.mode });
          });
          frame.appendChild(linkBtnJ);
          frame.appendChild(el("p", "trace-note", "✦ Сопровождение в группе «Маршрут Синей Руки»"));
        } else {
          var linkBtnI = el("a", "btn link", "Оставить след");
          linkBtnI.href = CFG.links.immersion;
          linkBtnI.target = "_blank";
          linkBtnI.rel = "noopener noreferrer";
          linkBtnI.addEventListener("click", function () {
            trackGoal("trace_link_click", { day: day.day, mode: self.mode });
          });
          frame.appendChild(linkBtnI);
          frame.appendChild(el("p", "trace-note", "✦ Сопровождение лично с Проводником"));
        }
        traceBody.appendChild(frame);
      }

      // ---- Внутренняя искорка: капля стартует из середины НИЖНЕГО КРАЯ
      // открытой (полноширинной) карточки практики — не из её центра, чтобы
      // не пролетать поверх текста практики — и опускается змейкой прямо к
      // заголовку «След дня» (он уже виден — это и есть цель полёта),
      // покачиваясь вправо-влево с затухающей неравной амплитудой, строго
      // вокруг вертикальной оси старта — без смещения в сторону A/B.
      // Цель считается ОДИН раз до начала полёта. Вопрос и рамка/CTA
      // «Следа дня» раскрываются только после прибытия капли к заголовку —
      // без дуги, линии и следа. ----
      function flySpark(openedBlock) {
        var stageRect = practiceStage.getBoundingClientRect();
        var fromRect = openedBlock.getBoundingClientRect();
        var fx = fromRect.left + fromRect.width / 2 - stageRect.left;
        var fy = fromRect.bottom - stageRect.top; // середина нижнего края карточки

        // Цель — центр заголовка «След дня» (он уже нарисован и виден —
        // капля летит именно к нему). Считается один раз, до старта полёта.
        var toRect = traceHeading.getBoundingClientRect();
        var tx = fx; // строго по вертикальной оси старта — без смещения A/B
        var ty = toRect.top + toRect.height / 2 - stageRect.top;

        var drop = el("div", "inner-spark-dot");
        drop.style.left = fx + "px";
        drop.style.top = fy + "px";
        innerSparkLayer.appendChild(drop);
        requestAnimationFrame(function () { drop.style.opacity = "1"; });

        // Раздел 15 ТЗ: если цель не помещается на экране — мягкая заблаговременная
        // автопрокрутка, чтобы было видно, как капля долетает до «Следа дня».
        var fitsInView = toRect.top >= 0 && toRect.bottom <= window.innerHeight;
        if (!fitsInView) {
          var targetScrollY = window.scrollY + toRect.top - Math.max(24, (window.innerHeight - toRect.height) / 2);
          window.scrollTo({ top: Math.max(0, targetScrollY), behavior: "smooth" });
        }

        var duration = 3200; // тайминг из прежнего удачного варианта
        var startTime = null;
        var totalDrop = ty - fy;
        // Затухающая "змейка": несколько волн вправо-влево с уменьшающейся
        // и неодинаковой амплитудой, гаснущая точно к моменту приземления.
        // Если расстояние до «Следа дня» небольшое — амплитуда и число волн
        // уменьшаются пропорционально, чтобы змейка не выглядела тесной/резкой.
        var swingsFull = [1, -0.62, 0.36, -0.16];
        var swings = totalDrop < 130 ? [1, -0.5] : swingsFull;
        var ampByWidth = Math.max(20, Math.min(60, fromRect.width * 0.14));
        var ampByDrop = totalDrop * 0.4;
        var baseAmp = Math.max(10, Math.min(ampByWidth, ampByDrop));

        function step(ts) {
          if (!startTime) startTime = ts;
          var t = Math.min(1, (ts - startTime) / duration);
          var easeY = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

          // огибающая амплитуды: 0 в начале и конце, пик в первой трети пути
          var envelope = Math.sin(Math.PI * t) * (1 - t);
          var wave = 0;
          for (var i = 0; i < swings.length; i++) {
            wave += swings[i] * Math.sin(t * Math.PI * (i + 1));
          }
          var sway = wave * envelope * baseAmp;

          drop.style.left = (tx + sway) + "px";
          drop.style.top = (fy + totalDrop * easeY) + "px";

          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            drop.style.left = tx + "px";
            drop.style.top = ty + "px";
            drop.style.transition = "opacity 0.35s ease";
            drop.style.opacity = "0";
            // Вопрос и рамка/CTA «Следа дня» раскрываются только ПОСЛЕ
            // прибытия капли к заголовку (не в полёте).
            fillTraceBody();
            requestAnimationFrame(function () { traceBody.classList.add("is-visible"); });
          }
        }
        requestAnimationFrame(step);

        setTimeout(function () { innerSparkLayer.innerHTML = ""; }, duration + 400);
      }

      function renderChosen(letter, animate) {
        practiceWrap.innerHTML = "";
        var chosen = letter === "A" ? day.practiceA : day.practiceB;
        var otherLetter = letter === "A" ? "B" : "A";

        var openedBlock = el("div", "practice-block opened");
        openedBlock.appendChild(el("h3", null, chosen.title));
        openedBlock.appendChild(renderRich(chosen.body));
        practiceWrap.appendChild(openedBlock);

        var otherBtn = el("button", "practice-btn disabled-choice");
        otherBtn.textContent = "Практика " + otherLetter;
        otherBtn.disabled = true;
        practiceWrap.appendChild(otherBtn);

        if (animate) {
          flySpark(openedBlock);
        } else {
          fillTraceBody();
          traceBody.classList.add("is-visible");
        }
      }

      function renderClosedChoice() {
        practiceWrap.innerHTML = "";
        ["A", "B"].forEach(function (letter) {
          var btn = el("button", "practice-btn");
          btn.textContent = "Практика " + letter;
          btn.addEventListener("click", function () {
            lsSet(choiceKey, letter);
            trackGoal("practice_choice", { day: day.day, choice: letter });
            renderChosen(letter, /* animate */ true);
          });
          practiceWrap.appendChild(btn);
        });
      }

      if (storedChoice === "A" || storedChoice === "B") {
        renderChosen(storedChoice, /* animate */ false);
      } else {
        renderClosedChoice();
      }
    },

    closeDayCard: function () {
      // Раздел 20 ТЗ: возврат в пространство маршрута, состояние дня
      // сохраняется, пульсация текущей точки восстанавливается (renderScene
      // перечитывает getDayState заново при каждом вызове).
      this.renderScene();
      showScreen("scene");
      if (this._sparkLayer) this._sparkLayer.innerHTML = "";
    },

    /* ---------------- DAY 13 FINALE ---------------- */
    startDay13Finale: function () {
      var root = screens.finale;
      root.innerHTML = "";

      var stage = el("div", "finale-stage");
      var startImg = el("img", null);
      startImg.src = "assets/day13_start.jpg";
      startImg.alt = "";
      stage.appendChild(startImg);
      root.appendChild(stage);
      showScreen("finale");

      var video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.muted = true;
      video.autoplay = true;
      video.controls = false;
      video.preload = "auto";
      video.style.opacity = "0";
      video.style.transition = "opacity 0.4s ease";
      stage.appendChild(video);

      // Хотфикс 3.2 п.7: финальные надписи и логотип — поверх ЕЩЁ ИГРАЮЩЕГО
      // видео. Никакого переключения на отдельный стоп-кадр после видео:
      // руки естественно доигрывают namaste прямо в ролике, а текст
      // появляется заранее, пока движение ещё продолжается.
      var overlay = el("div", "finale-text-overlay");
      var line1 = el("div", "line line-1", CFG.finale.lines[0]);
      var line2 = el("div", "line line-2", CFG.finale.lines[1]);
      overlay.appendChild(line1);
      overlay.appendChild(line2);
      stage.appendChild(overlay);

      var logo = el("div", "finale-logo");
      var logoImg = el("img", null);
      logoImg.src = "assets/logo_gold.png";
      logoImg.alt = "13 MIRRORS · Калейдоскоп твоих миров";
      logo.appendChild(logoImg);
      stage.appendChild(logo);

      var textsShown = false;
      function showFinaleTexts() {
        if (textsShown) return;
        textsShown = true;
        line1.classList.add("is-visible");
        setTimeout(function () { line2.classList.add("is-visible"); }, 700);
        setTimeout(function () { logo.classList.add("is-visible"); }, 700);
      }

      var revealed = false;
      var fallbackDone = false;
      function reveal() {
        if (revealed) return;
        revealed = true;
        video.style.opacity = "1";
        startImg.style.opacity = "0";
      }
      // Если видео вообще не может проиграться в этом браузере (не тот формат,
      // сеть и т.п.) — единственный случай, когда остаётся статичный кадр:
      // самого видео не было, показать нечего кроме стоп-кадра с текстом.
      function fallbackToFinal() {
        if (fallbackDone) return;
        fallbackDone = true;
        // убираем ещё не показанный оверлей/логотип этого запуска — иначе
        // finishFinaleScene() добавит второй комплект поверх
        overlay.remove();
        logo.remove();
        App.finishFinaleScene(stage, /*fromEnd*/ true);
      }

      video.addEventListener("playing", reveal);
      video.addEventListener("error", fallbackToFinal);

      // Текст проявляется заранее относительно фактического конца ролика —
      // ещё во время движения рук, а не после его завершения.
      var textScheduled = false;
      video.addEventListener("timeupdate", function () {
        if (textScheduled || !video.duration || !isFinite(video.duration)) return;
        if (video.duration - video.currentTime <= 3.4) {
          textScheduled = true;
          showFinaleTexts();
        }
      });
      video.addEventListener("ended", function () {
        // Видео просто доигрывает и естественно останавливается на
        // последнем кадре namaste — никакой замены на статичное изображение.
        showFinaleTexts();
        lsSet(LS.FINALE_PLAYED, App.state.todayKey);
        trackGoal("day13_completed");
      });

      var playAttempted = false;
      function tryPlay() {
        if (playAttempted) return;
        playAttempted = true;
        var p = video.play();
        if (p && p.catch) {
          p.then(reveal).catch(function () {
            if (video.error) { fallbackToFinal(); return; }
            // автоплей заблокирован политикой браузера — показать кнопку запуска
            App.showFinaleTapToPlay(stage, video, startImg, fallbackToFinal);
          });
        } else {
          reveal();
        }
      }

      video.addEventListener("canplay", tryPlay, { once: true });
      setTimeout(tryPlay, 600);
      // если через 6с ничего не произошло (ни воспроизведение, ни ошибка,
      // ни кнопка запуска) — считаем формат неподдерживаемым и идём в финал
      setTimeout(function () {
        if (!revealed && !fallbackDone && !stage.querySelector(".finale-tap-btn")) fallbackToFinal();
      }, 6000);

      video.src = "assets/day13_namaste.mp4";
      video.load();
    },

    showFinaleTapToPlay: function (stage, video, startImg, fallbackToFinal) {
      var btn = el("button", "btn primary finale-tap-btn", "Продолжить");
      btn.addEventListener("click", function () {
        video.muted = false;
        video.play().then(function () {
          video.style.opacity = "1";
          startImg.style.opacity = "0";
          btn.remove();
        }).catch(function () {
          if (video.error) { btn.remove(); fallbackToFinal(); return; }
          video.muted = true;
          video.play();
          video.style.opacity = "1";
          startImg.style.opacity = "0";
          btn.remove();
        });
      });
      stage.appendChild(btn);
    },

    // Только запасной сценарий: видео в этом браузере не воспроизвелось вовсе
    // (ошибка / неподдерживаемый формат) — единственный случай, когда
    // показывается статичный стоп-кадр с наложенным текстом. При обычном
    // проигрывании эта функция больше не вызывается (см. startDay13Finale —
    // текст и логотип теперь идут поверх ещё играющего видео, хотфикс 3.2 п.7).
    finishFinaleScene: function (stage, fromEnd) {
      // финальный кадр
      var existingVideo = stage.querySelector("video");
      if (existingVideo) existingVideo.style.opacity = "0";
      var finalImg = el("img", null);
      finalImg.src = "assets/day13_final.jpg";
      finalImg.alt = "";
      stage.appendChild(finalImg);

      // TEMP_OVERLAY — см. комментарий выше метода.
      // Раздел 24 ТЗ: в левом верхнем углу, строки появляются по очереди —
      // сначала «Маршрут пройден.», следом курсивом «Увидимся за поворотом…».
      var overlay = el("div", "finale-text-overlay");
      var line1 = el("div", "line line-1", CFG.finale.lines[0]);
      var line2 = el("div", "line line-2", CFG.finale.lines[1]);
      overlay.appendChild(line1);
      overlay.appendChild(line2);
      stage.appendChild(overlay);

      // Настоящий логотип 13 MIRRORS, перекрашенный в золото (раздел 26 ТЗ)
      var logo = el("div", "finale-logo");
      var logoImg = el("img", null);
      logoImg.src = "assets/logo_gold.png";
      logoImg.alt = "13 MIRRORS · Калейдоскоп твоих миров";
      logo.appendChild(logoImg);
      stage.appendChild(logo);

      requestAnimationFrame(function () {
        setTimeout(function () { line1.classList.add("is-visible"); }, 300);
        setTimeout(function () { line2.classList.add("is-visible"); }, 1300);
        setTimeout(function () { logo.classList.add("is-visible"); }, 1300);
      });

      if (fromEnd) {
        lsSet(LS.FINALE_PLAYED, this.state.todayKey);
        trackGoal("day13_completed");
      }
    },

    /* ---------------- Полностью завершённый маршрут (после 4 октября) ---------------- */
    showCompletedFinale: function () {
      var root = screens.finale;
      root.innerHTML = "";
      var stage = el("div", "finale-stage");
      var finalImg = el("img", null);
      finalImg.src = "assets/day13_final.jpg";
      finalImg.alt = "";
      stage.appendChild(finalImg);

      var overlay = el("div", "finale-text-overlay");
      overlay.appendChild(el("div", "line line-1 is-visible", CFG.finale.lines[0]));
      overlay.appendChild(el("div", "line line-2 is-visible", CFG.finale.lines[1]));
      stage.appendChild(overlay);

      // Настоящий логотип 13 MIRRORS, перекрашенный в золото (раздел 26 ТЗ)
      var logo = el("div", "finale-logo is-visible");
      var logoImg = el("img", null);
      logoImg.src = "assets/logo_gold.png";
      logoImg.alt = "13 MIRRORS · Калейдоскоп твоих миров";
      logo.appendChild(logoImg);
      stage.appendChild(logo);

      root.appendChild(stage);
      showScreen("finale");
    }
  };

  window.BH_APP = App;
  document.addEventListener("DOMContentLoaded", function () { App.init(); });
})();
