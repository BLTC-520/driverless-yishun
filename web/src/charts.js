/* Driverless Yishun: the shared Apache ECharts set-up for the Part 2 chapter (phase2.js) and the
   evidence page (evidence.js). The Part 1 story charts in app.js stay in D3, because they redraw
   step by step as the captions scroll past.
   One theme, built from the page's CSS colour tokens, gives every chart the same paper, ink, type and
   gridlines as the text around it; docs/echarts.md walks through how a chart is put together. */
(function () {
  "use strict";
  if (typeof echarts === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => css.getPropertyValue(n).trim();
  const T = { fg: tok("--fg"), mute: tok("--mute"), faint: tok("--faint"), rule: tok("--rule"), bg: tok("--bg"), surface: tok("--bg-2") || "#fff",
              font: tok("--font-data") || "ui-monospace, monospace" };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // the theme: every axis, gridline and label in the page's own tokens, as the D3 charts' .axis and .grid CSS did
  const axis = {
    axisLine: { lineStyle: { color: T.rule } }, axisTick: { lineStyle: { color: T.rule } },
    axisLabel: { color: T.mute, fontFamily: T.font, fontSize: 12 }, splitLine: { lineStyle: { color: T.rule } },
    nameTextStyle: { color: T.mute, fontFamily: T.font, fontSize: 12 },
  };
  echarts.registerTheme("yishun", {
    backgroundColor: "transparent",
    textStyle: { fontFamily: T.font, color: T.mute, fontSize: 12 },
    categoryAxis: axis, valueAxis: axis,
  });

  // the tooltip every chart shares: the page's paper and hairline; .ec-tip .mute in the page CSS greys secondary lines
  const TIP = {
    className: "ec-tip", confine: true, transitionDuration: 0,
    backgroundColor: T.surface, borderColor: T.rule, borderWidth: 1, padding: [8, 10],
    textStyle: { color: T.fg, fontFamily: T.font, fontSize: 12 },
    extraCssText: "border-radius:4px;box-shadow:0 4px 16px rgb(0 0 0 / .08);max-width:320px;white-space:normal;line-height:1.45;",
  };

  // A label drawn over the chart: the D3 charts' .lab (muted) and .callout (ink) text, with a halo in the paper colour.
  const lab = (extra) => ({ color: T.mute, fontFamily: T.font, fontSize: 12, textBorderColor: T.bg, textBorderWidth: 3, ...extra });
  const callout = (extra) => lab({ color: T.fg, ...extra });

  // Axis titles where the D3 charts put them: the x title right-aligned under the axis, the y title above it.
  const xName = (name, gap = 26) => ({ name, nameLocation: "end", nameGap: 0, nameTextStyle: { align: "right", verticalAlign: "top", padding: [gap, 0, 0, 0] } });
  const yName = (name) => ({ name, nameLocation: "end", nameGap: 10, nameTextStyle: { align: "left" } });

  // Draws a chart into the <div id="..."> of that id, at the given height (in pixels), replacing whatever it showed.
  // Returns the ECharts instance, or null when the div has no width yet (inside a closed <details>: drawn when it opens).
  function draw(id, option, height) {
    const el = document.getElementById(id);
    if (!el || !el.clientWidth) return null;
    if (height) el.style.height = `${height}px`;
    const chart = echarts.getInstanceByDom(el) || echarts.init(el, "yishun", { renderer: "svg" });
    chart.resize();
    const full = { animation: !still, animationDuration: 450, ...option };
    if (option.tooltip) full.tooltip = { ...TIP, ...option.tooltip };
    chart.setOption(full, true);   // true: replace the previous option instead of merging into it
    return chart;
  }
  const width = (id) => (document.getElementById(id) || {}).clientWidth || 0;

  // ECharts has ready-made bars, lines and points but no range bar or whisker, so these two use a "custom"
  // series: ECharts calls renderItem once per data item, and api.coord turns data values into pixels.
  // Each item is [x0, y0, x1, y1] in data units (a category axis counts its rows 0, 1, 2...); its colour is
  // the item's own itemStyle.color, read back with api.visual("color").
  function segments(data, opt = {}) {
    return {
      type: "custom", silent: !opt.tooltip, data, z: opt.z ?? 2, encode: { x: [0, 2], y: [1, 3] }, tooltip: { show: false },
      renderItem: (params, api) => {
        const a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(2), api.value(3)]), dy = opt.dy || 0;
        return { type: "line", shape: { x1: a[0], y1: a[1] + dy, x2: b[0], y2: b[1] + dy },
          style: { stroke: api.visual("color"), lineWidth: opt.width || 2, lineCap: opt.cap || "butt", lineDash: opt.dash } };
      },
    };
  }
  // floating horizontal bars, one per item [x0, row, x1], `height` pixels tall, rounded at the ends
  function spans(data, opt = {}) {
    return {
      type: "custom", data, z: opt.z ?? 2, encode: { x: [0, 2], y: 1 },
      renderItem: (params, api) => {
        const a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(2), api.value(1)]), h = opt.height || 12;
        return { type: "rect", shape: { x: Math.min(a[0], b[0]), y: a[1] - h / 2 + (opt.dy || 0), width: Math.max(1, Math.abs(b[0] - a[0])), height: h, r: opt.radius ?? 3 },
          style: { fill: api.visual("color"), opacity: opt.opacity ?? 1 } };
      },
    };
  }

  // On phones the row names of a horizontal chart sit above their row instead of beside it, cut to the chart's width.
  // (Give that chart's grid outerBoundsMode: "none", or ECharts squeezes the plot to keep the long names inside.)
  const rowNamesAbove = (formatter, width) => ({ inside: true, align: "left", verticalAlign: "bottom", padding: [0, 0, 8, 0], formatter,
    width, overflow: "truncate", ellipsis: "…" });
  // beside the row, right-aligned, cut to the margin they have
  const rowNames = (formatter, width) => ({ formatter, width, overflow: "truncate", ellipsis: "…" });

  // A round number at or beyond v, away from zero (1,234 -> 1,500), for an axis end the chart needs to know in advance.
  function nice(v) {
    if (!v) return 0;
    const p = 10 ** Math.floor(Math.log10(Math.abs(v))), f = Math.abs(v) / p;
    return Math.sign(v) * [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k >= f - 1e-9) * p;
  }

  window.Charts = { T, tok, draw, width, lab, callout, xName, yName, segments, spans, rowNamesAbove, rowNames, nice };
})();
